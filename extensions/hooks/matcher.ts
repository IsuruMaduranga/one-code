/**
 * Hook matcher evaluation (pure). Claude Code matchers are anchored,
 * case-insensitive regexes over CC tool names ("Bash", "Edit|Write",
 * "mcp__server__.*"); One Code tools are snake_case, so every candidate
 * spelling of a tool — native name, canonical CC name, and the alias table
 * from permissions/matcher.ts — is tested.
 */

import { ccAliasesForTool } from "../permissions/matcher.ts";

/**
 * Canonical Claude Code PascalCase name per One Code tool, for hook matchers
 * and the `tool_name` stdin field (CC hook scripts compare exact strings like
 * "Bash"). Tools with no CC counterpart pass through unchanged.
 */
const CC_CANONICAL: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
	notebook_edit: "NotebookEdit",
	web_fetch: "WebFetch",
	web_search: "WebSearch",
	subagent: "Task",
	skill: "Skill",
	ask_user_question: "AskUserQuestion",
	enter_plan_mode: "EnterPlanMode",
	exit_plan_mode: "ExitPlanMode",
	task_create: "TaskCreate",
	task_get: "TaskGet",
	task_list: "TaskList",
	task_update: "TaskUpdate",
	task_output: "TaskOutput",
	task_stop: "TaskStop",
	monitor: "Monitor",
	schedule_wakeup: "ScheduleWakeup",
	send_message: "SendMessage",
	enter_worktree: "EnterWorktree",
	exit_worktree: "ExitWorktree",
	workflow: "Workflow",
};

export function ccToolName(nativeName: string): string {
	if (nativeName.startsWith("mcp__")) return nativeName;
	return CC_CANONICAL[nativeName] ?? nativeName;
}

/**
 * pi parameter name → Claude Code parameter name, per tool, for the hook stdin
 * payload's `tool_input`. A CC hook reads `.tool_input.file_path`; pi's tools
 * call it `path` (review T4). Tools not listed pass their input through
 * unchanged (bash's `command`/`timeout`/`description`/`run_in_background`
 * already match CC's Bash; MCP tools are their own schema).
 */
const CC_INPUT_NAMES: Record<string, Record<string, string>> = {
	read: { path: "file_path" },
	edit: { path: "file_path", oldText: "old_string", newText: "new_string" },
	write: { path: "file_path" },
	grep: { ignoreCase: "-i", context: "-C", limit: "head_limit" },
	notebook_edit: { path: "notebook_path" },
};

function renameKeys(input: Record<string, unknown>, names: Record<string, string>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) out[names[key] ?? key] = value;
	return out;
}

/** A pi tool's input spelled with Claude Code's parameter names. */
export function ccToolInput(nativeName: string, input: Record<string, unknown>): Record<string, unknown> {
	const names = CC_INPUT_NAMES[nativeName];
	return names ? renameKeys(input, names) : input;
}

/** The inverse: a hook's `updatedInput` (CC names) back to the pi tool's names. */
export function nativeToolInput(nativeName: string, input: Record<string, unknown>): Record<string, unknown> {
	const names = CC_INPUT_NAMES[nativeName];
	if (!names) return input;
	const inverse = Object.fromEntries(Object.entries(names).map(([pi, cc]) => [cc, pi]));
	return renameKeys(input, inverse);
}

/** Every spelling a matcher may reasonably target for this tool. */
export function toolMatchCandidates(nativeName: string): string[] {
	return [...new Set([nativeName, ccToolName(nativeName), ...ccAliasesForTool(nativeName)])];
}

/**
 * Whether a CC matcher applies to any candidate spelling. Anchored and
 * case-insensitive (`^(?:matcher)$`, the CC semantics); an invalid regex
 * falls back to case-insensitive exact comparison rather than throwing.
 */
export function matcherApplies(matcher: string | undefined, candidates: string[]): boolean {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	let regex: RegExp | undefined;
	try {
		regex = new RegExp(`^(?:${matcher})$`, "i");
	} catch {
		regex = undefined;
	}
	const lowered = matcher.toLowerCase();
	return candidates.some((candidate) => (regex ? regex.test(candidate) : candidate.toLowerCase() === lowered));
}

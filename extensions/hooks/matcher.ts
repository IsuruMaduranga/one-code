/**
 * Hook matcher evaluation (pure). Claude Code matchers are anchored,
 * case-insensitive regexes over CC tool names ("Bash", "Edit|Write",
 * "mcp__server__.*"); pincer tools are snake_case, so every candidate
 * spelling of a tool — pincer name, canonical CC name, and the alias table
 * from permissions/matcher.ts — is tested.
 */

import { ccAliasesForTool } from "../permissions/matcher.ts";

/**
 * Canonical Claude Code PascalCase name per pincer tool, for hook matchers
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
	todo_write: "TodoWrite",
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

export function ccToolName(pincerName: string): string {
	if (pincerName.startsWith("mcp__")) return pincerName;
	return CC_CANONICAL[pincerName] ?? pincerName;
}

/** Every spelling a matcher may reasonably target for this tool. */
export function toolMatchCandidates(pincerName: string): string[] {
	return [...new Set([pincerName, ccToolName(pincerName), ...ccAliasesForTool(pincerName)])];
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

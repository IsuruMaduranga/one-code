/**
 * Plan-mode reminder text (pure). Byte-identical for a given plan-file path,
 * whether or not the file exists yet: the block is a sticky-append reminder
 * carried by every user message since plan mode came on, and the queue keeps
 * that anchor only while the re-emitted text is unchanged. A text that flipped
 * when the file appeared re-anchored the block and re-cached every message
 * between entering plan mode and the first write (CACHE-REVIEW-2026-09-04 M2).
 *
 * Adapted from Claude Code's plan-mode system message: the plan lives in a
 * file the model builds incrementally — the one writable path in plan mode —
 * and exit_plan_mode reads that file rather than taking the plan as a
 * parameter. Claude Code's own text does vary with the file's existence; ours
 * folds both states into one sentence so the cached prefix survives.
 */

export function buildPlanModeReminder(filePath: string): string {
	const fileLine = `Build your plan at ${filePath} with the write/edit tools — create it if it does not exist yet, then edit it incrementally rather than rewriting it from scratch. Do not present the plan as chat text.`;
	return [
		`Plan mode is active. You may only use read-only tools; edit and write are blocked everywhere except one file. ${fileLine}`,
		"",
		"Workflow:",
		'1. Explore: delegate broad reconnaissance to the `Agent` tool with `subagent_type: "explore"` (up to 3 in parallel) rather than reading everything yourself.',
		'2. Design: delegate the implementation strategy to the `Agent` tool with `subagent_type: "plan"` once exploration has mapped the ground.',
		"3. Review the critical files yourself, and call `ask_user_question` for any decision you cannot make on the user's behalf.",
		`4. Write the final plan to ${filePath}: a Context section explaining why, your recommended approach (not several options), the critical files named, existing utilities to reuse, and a verification section.`,
		"5. Call `exit_plan_mode` to ask the user to approve the plan. It reads the plan file directly — you do not pass the plan as a parameter. If `exit_plan_mode` is not in your active tools, load it first with tool_search (`select:exit_plan_mode`).",
		"",
		"End every plan-mode turn with either `ask_user_question` or `exit_plan_mode`. Never ask for plan approval in chat text.",
	].join("\n");
}

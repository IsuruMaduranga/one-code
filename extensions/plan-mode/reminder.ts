/**
 * Plan-mode reminder text (pure). Byte-identical for a given state so the
 * every-turn re-emit replaces the queue entry with the same string except when
 * the state genuinely changed (file created, different path).
 *
 * Mirrors Claude Code's plan-mode system message: the plan lives in a file the
 * model builds incrementally — the one writable path in plan mode — and
 * exit_plan_mode reads that file rather than taking the plan as a parameter.
 */

export interface PlanReminderState {
	filePath: string;
	fileExists: boolean;
}

export function buildPlanModeReminder({ filePath, fileExists }: PlanReminderState): string {
	const fileLine = fileExists
		? `Continue building your plan at ${filePath} with the write/edit tools — edit it incrementally rather than rewriting it from scratch.`
		: `No plan file exists yet — create it at ${filePath} with the write tool. Build the plan there incrementally as you investigate; do not present the plan as chat text.`;

	return [
		`Plan mode is active. You may only use read-only tools; edit and write are blocked everywhere except one file. ${fileLine}`,
		"",
		"Workflow:",
		'1. Explore: delegate broad reconnaissance to `subagent` with `agent: "explore"` (up to 3 in parallel) rather than reading everything yourself.',
		'2. Design: delegate the implementation strategy to `subagent` with `agent: "plan"` once exploration has mapped the ground.',
		"3. Review the critical files yourself, and call `ask_user_question` for any decision you cannot make on the user's behalf.",
		`4. Write the final plan to ${filePath}: a Context section explaining why, your recommended approach (not several options), the critical files named, existing utilities to reuse, and a verification section.`,
		"5. Call `exit_plan_mode` to ask the user to approve the plan. It reads the plan file directly — you do not pass the plan as a parameter.",
		"",
		"End every plan-mode turn with either `ask_user_question` or `exit_plan_mode`. Never ask for plan approval in chat text.",
	].join("\n");
}

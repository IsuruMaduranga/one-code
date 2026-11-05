/**
 * What the context-budget extension needs from a profile (types only): the
 * words that tell the model how much of its per-turn token budget is left.
 * The budget, the countdown and the `<total_tokens>` frame stay in the base
 * (budget.ts; lib/reminders.ts recognizes the frame on a tool result); the
 * system prompt's last line carries the same block at the full budget.
 */

export interface ContextBudgetText {
	/** The budget left, in tokens: the full budget at a turn's start, then the countdown on each tool result. */
	tokensLeft(p: { left: number }): string;
}

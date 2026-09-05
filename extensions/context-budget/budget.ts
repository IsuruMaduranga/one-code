/**
 * Claude Code's `<total_tokens>N tokens left</total_tokens>` signal, pure half.
 *
 * What the number is (read off a live Claude Code session and the 2.1.261
 * capture, findings §14): a PER-TURN token budget, not the context window. It
 * reads 15,000,000 at every turn start — the last line of the system prompt
 * before the gitStatus block, and the end of every user message — and counts
 * down on the tool results within the turn by roughly what each round added
 * (tool results, assistant output); the next user message resets it. Constant
 * at the cached-prefix positions, variable only on the tail, so it never busts
 * the prefix. One Code approximates the countdown as the growth of the context
 * since the turn started (pi's context-usage estimate), the same quantity to
 * within the estimator's error. `CC_TOTAL_TOKENS_BUDGET` overrides the figure.
 */

/** Claude Code's per-turn budget as observed; the meaning of the figure is CC's max tokens per turn with compaction. */
export const DEFAULT_TURN_TOKEN_BUDGET = 15_000_000;

/** The configured budget: `CC_TOTAL_TOKENS_BUDGET` when it is a positive number, else Claude Code's default. */
export function turnTokenBudget(env: Record<string, string | undefined> = process.env): number {
	const raw = env.CC_TOTAL_TOKENS_BUDGET;
	const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_TURN_TOKEN_BUDGET;
}

function finite(n: number | null | undefined): number | undefined {
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * One turn's countdown. `startTurn` takes the context size the turn begins
 * from; `left` takes the size now and returns what remains of the budget. The
 * value never rises within a turn (as CC's does not), the first known size
 * becomes the baseline when the turn started without an estimate, and an
 * unknown size repeats the last value.
 */
export class TurnBudget {
	private start: number | undefined;
	private spent = 0;

	constructor(readonly budget: number) {}

	startTurn(contextTokens: number | null | undefined): void {
		this.start = finite(contextTokens);
		this.spent = 0;
	}

	left(contextTokens: number | null | undefined): number {
		const now = finite(contextTokens);
		if (now !== undefined) {
			if (this.start === undefined) this.start = now;
			this.spent = Math.max(this.spent, now - this.start);
		}
		return Math.max(0, this.budget - this.spent);
	}
}

/** The bare block Claude Code appends, byte-for-byte. */
export function totalTokensBlock(left: number): string {
	return `<total_tokens>${left} tokens left</total_tokens>`;
}

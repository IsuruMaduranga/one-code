/**
 * When the recap may run, after Claude Code 2.1.330's away-summary scheduler
 * (findings §102). Pure: no pi imports; index.ts gathers the probe.
 *
 * The delay is Claude Code's 3 minutes, capped at 0.8 of the prompt cache's
 * lifetime. When the timer fires, the first skip that applies wins, in Claude
 * Code's order. A skip does not count as a recap: the next keystroke or turn
 * end arms the timer again.
 */

/** Claude Code's `tengu_sedge_lantern_config.delayMs` default. */
export const RECAP_DELAY_MS = 180_000;
/** The provider's default prompt-cache lifetime, and the one-hour lifetime of an interactive session's Anthropic cache. */
export const FIVE_MINUTE_CACHE_MS = 300_000;
export const ONE_HOUR_CACHE_MS = 3_600_000;
/** Failed recaps allowed per turn before the recap stops trying until the next one. */
export const MAX_FAILURES_PER_TURN = 3;
/** How many recaps of a run end with the hint on how to turn recaps off. */
export const HINTED_RECAPS = 3;
/** Claude Code's minimums: three user turns in all, two since the last recap. */
const MIN_USER_TURNS = 3;
const MIN_TURNS_SINCE_RECAP = 2;

/** The idle delay: the configured one, but never past 0.8 of the cache's lifetime. */
export function recapDelayMs(configuredMs: number, cacheLifetimeMs: number): number {
	return Math.min(configuredMs, cacheLifetimeMs * 0.8);
}

/** One branch entry as the turn count sees it: a user prompt, a recap, or anything else. */
export type BranchMark = "user" | "recap" | undefined;

/**
 * Claude Code's turn rule: at least three user turns in the transcript, and at
 * least two since the last recap. A recap that is the last entry fails it.
 */
export function enoughUserTurns(marks: readonly BranchMark[]): boolean {
	const lastRecap = marks.lastIndexOf("recap");
	const count = (from: number) => marks.slice(from).filter((mark) => mark === "user").length;
	if (count(0) < MIN_USER_TURNS) return false;
	return lastRecap === -1 || count(lastRecap + 1) >= MIN_TURNS_SINCE_RECAP;
}

export interface RecapProbe {
	now: number;
	/** When the last turn ended in this process; undefined before the first one. */
	lastTurnEndAt: number | undefined;
	cacheLifetimeMs: number;
	/** Anthropic's `anthropic-ratelimit-unified-status` from the latest response, if any. */
	rateLimitStatus: string | undefined;
	/** The text in the prompt box. */
	draft: string;
	pendingAgents: number;
	pendingWorkflows: number;
	/** A `schedule_wakeup` wakeup is armed. */
	wakeupPending: boolean;
	inFlight: boolean;
	failuresThisTurn: number;
	marks: readonly BranchMark[];
}

export type RecapSkip = "cache_unknown" | "cache_stale" | "near_limit" | "draft" | "background_work" | "wakeup" | "in_flight" | "failing" | "few_turns";

/** The first skip that applies, in Claude Code's order, or null to run the recap. */
export function recapSkip(probe: RecapProbe): RecapSkip | null {
	if (probe.lastTurnEndAt === undefined) return "cache_unknown";
	if (probe.now - probe.lastTurnEndAt > probe.cacheLifetimeMs * 0.9) return "cache_stale";
	if (probe.rateLimitStatus !== undefined && probe.rateLimitStatus !== "allowed") return "near_limit";
	if (probe.draft !== "") return "draft";
	if (probe.pendingAgents > 0 || probe.pendingWorkflows > 0) return "background_work";
	if (probe.wakeupPending) return "wakeup";
	if (probe.inFlight) return "in_flight";
	if (probe.failuresThisTurn >= MAX_FAILURES_PER_TURN) return "failing";
	if (!enoughUserTurns(probe.marks)) return "few_turns";
	return null;
}

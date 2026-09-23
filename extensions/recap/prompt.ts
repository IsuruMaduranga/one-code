/**
 * Pure pieces of Claude Code's "while you were away" recap (the ※ line CC shows
 * when you come back after stepping away). Prompt text is verbatim from CC's
 * services/awaySummary.ts; the display format matches CC's away_summary render
 * (dim, led by the ※ reference mark). The session-memory block CC optionally
 * prepends is omitted here (kept decoupled from One Code's memory extension).
 */

import { trimToTurnBoundary } from "../lib/side-call.ts";

/** CC's REFERENCE_MARK (figures.ts) — the away-summary/recap marker. */
export const REFERENCE_MARK = "※";

/**
 * Recap only needs recent context; CC truncates to the last 30 messages to
 * avoid "prompt too long" on large sessions (≈15 exchanges — plenty for
 * "where we left off").
 */
export const RECENT_MESSAGE_WINDOW = 30;

/** The away-summary instruction, verbatim from Claude Code 2.1.261's request (no memory block). */
export const RECAP_PROMPT =
	"The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

/** The transcript text after the ※ mark, matching CC's shipped "recap: …" line. */
export function recapLine(content: string): string {
	return `recap: ${content.trim()}`;
}

/**
 * The recent-message window for the recap: the last `window` messages, trimmed
 * forward to the first clean turn boundary — a `user` prompt or an `assistant`
 * reply. A raw slice can begin mid-exchange with a leading tool-result message
 * whose matching assistant tool_use fell outside the window; convertToLlm would
 * then emit an orphan tool_result block that strict providers (e.g. Anthropic)
 * reject, silently failing the recap. An assistant start is safe — its own tool
 * results follow within the window. When the window holds no user/assistant
 * message at all (e.g. one long tool-only stretch), nothing is safe to send, so
 * it returns empty and the recap runs on the instruction alone. Generic over
 * `{ role }` so it is testable with plain objects.
 */
export function recentForRecap<T extends { role: string }>(messages: readonly T[], window = RECENT_MESSAGE_WINDOW): T[] {
	return trimToTurnBoundary(messages.slice(-window));
}

/**
 * Pure pieces of Claude Code's "while you were away" recap (the ※ line CC shows
 * when you come back after stepping away). Prompt text is verbatim from CC's
 * services/awaySummary.ts; the display format matches CC's away_summary render
 * (dim, led by the ※ reference mark). The session-memory block CC optionally
 * prepends is omitted here (kept decoupled from One Code's memory extension).
 */

/** CC's REFERENCE_MARK (figures.ts) — the away-summary/recap marker. */
export const REFERENCE_MARK = "※";

/**
 * Recap only needs recent context; CC truncates to the last 30 messages to
 * avoid "prompt too long" on large sessions (≈15 exchanges — plenty for
 * "where we left off").
 */
export const RECENT_MESSAGE_WINDOW = 30;

/** The away-summary instruction, verbatim from CC's buildAwaySummaryPrompt (no memory block). */
export const RECAP_PROMPT =
	"The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.";

/** The transcript text after the ※ mark, matching CC's shipped "recap: …" line. */
export function recapLine(content: string): string {
	return `recap: ${content.trim()}`;
}

/**
 * The recent-message window for the recap: the last `window` messages, trimmed
 * forward to start at a user turn. A raw slice can begin mid-exchange, with a
 * leading tool_result whose matching assistant tool_use fell outside the
 * window — strict providers (e.g. Anthropic) reject that orphan, and the recap
 * would silently fail. Starting at a user message keeps every tool_use/
 * tool_result pair intact. Generic over `{ role }` so it is testable with plain
 * objects; when no user message is in the window the whole slice is kept.
 */
export function recentForRecap<T extends { role: string }>(messages: readonly T[], window = RECENT_MESSAGE_WINDOW): T[] {
	const tail = messages.slice(-window);
	const firstUser = tail.findIndex((message) => message.role === "user");
	return firstUser > 0 ? tail.slice(firstUser) : tail;
}

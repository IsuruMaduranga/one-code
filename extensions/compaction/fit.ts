/**
 * Which request shape a compaction takes, and how a standalone one is made to
 * fit the window (pure — no pi imports).
 *
 * Two shapes exist:
 *
 * - **Replay**: the session's last real request (captured from the `context`
 *   event) plus the instruction. Cache-aligned, so the call is mostly cache
 *   reads — the reason the extension compacts on the session model at all.
 *   It only works while the captured request leaves room for the summary:
 *   pi clamps `max_tokens` to `contextWindow − estimate − 4096`
 *   (`clampMaxTokensToContext`), so a request at or over the window is sent
 *   with `max_tokens` 1, or the provider rejects it outright. Both return
 *   nothing usable. An overflow-triggered compaction is *by definition* in
 *   that state (review H2: every overflow fell through to pi's summary).
 *
 * - **Standalone**: the doomed span alone (what pi is about to discard,
 *   reconstructed from `preparation`), no tools, a one-line system prompt, and
 *   the instruction. It cannot hit the cache, which is moot on an overflowing
 *   request anyway; what it keeps is One Code's summary: the nine sections,
 *   the continuation preamble, and the transcript pointer. Even the doomed
 *   span may not fit — pi keeps only ~20k tokens after the cut, so on an
 *   overflow the span is nearly the whole window — so `fitToBudget` clears
 *   the largest tool results first until the estimate fits. Their full text is
 *   in the session transcript the summary points at (Claude Code's own
 *   microcompact clears old tool results the same way).
 *
 * Token estimates here are deliberately conservative (JSON length / 4, above
 * pi's chars / 4): overshooting the estimate costs a little summary detail,
 * undershooting costs the whole compaction.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** pi's `clampMaxTokensToContext` safety margin (pi-ai `simple-options`). */
export const CONTEXT_SAFETY_TOKENS = 4096;

/**
 * The least output room a replay must leave for the summary. Below it the
 * clamp truncates the reply (or the request is rejected) and pi's summary
 * would serve instead. With pi's default `reserveTokens` (16 384) a threshold
 * compaction leaves ~12k, comfortably above; an overflow leaves nothing.
 */
export const MIN_REPLAY_SUMMARY_TOKENS = 4096;

/** The output room a standalone request reserves for the summary. */
export const STANDALONE_SUMMARY_TOKENS = 8192;

/** How much of a cleared tool result's text is kept as a landmark. */
export const CLEARED_RESULT_HEAD_CHARS = 1000;

export interface ReplayDecision {
	reason: "manual" | "threshold" | "overflow";
	/** `model.contextWindow`; 0 or less means unknown (pi does not clamp then either). */
	contextWindow: number;
	/** pi's estimate of the whole pre-compaction context (`preparation.tokensBefore`). */
	tokensBefore: number;
}

/**
 * True when replaying the captured request would leave room for the summary.
 * An overflow never does — the request that just failed *is* the capture.
 */
export function replayFits({ reason, contextWindow, tokensBefore }: ReplayDecision): boolean {
	if (reason === "overflow") return false;
	if (contextWindow <= 0) return true;
	return contextWindow - tokensBefore - CONTEXT_SAFETY_TOKENS >= MIN_REPLAY_SUMMARY_TOKENS;
}

/** Conservative token estimate of a message: JSON length / 4 (pi uses plain chars / 4). */
export function estimateMessageTokens(message: AgentMessage): number {
	const m = message as { role: string; content?: unknown; summary?: unknown };
	const body = m.role === "compactionSummary" ? m.summary : m.content;
	return Math.ceil(JSON.stringify(body ?? "").length / 4);
}

/** Conservative token estimate of a text (JSON length / 4, matching `estimateMessageTokens`). */
export function estimateTextTokens(text: string): number {
	return Math.ceil(JSON.stringify(text).length / 4);
}

/**
 * The input budget of a standalone request: the window minus pi's safety
 * margin, the summary's room, and the fixed parts of the request. `Infinity`
 * when the window is unknown.
 */
export function standaloneBudget(contextWindow: number, fixedTokens: number): number {
	if (contextWindow <= 0) return Number.POSITIVE_INFINITY;
	return contextWindow - CONTEXT_SAFETY_TOKENS - STANDALONE_SUMMARY_TOKENS - fixedTokens;
}

/**
 * Clears the largest tool results (oldest first on a tie) until the estimated
 * size of `messages` is within `budgetTokens`. Each cleared result keeps its
 * opening text as a landmark plus a note saying where the full text lives.
 * Nothing but tool results is touched; if clearing every one still does not
 * fit, the rest is left as is (the provider's verdict decides, and pi's
 * summary serves on failure). Returns new arrays and messages — the inputs are
 * never mutated (the captured request is a live reference).
 */
export function fitToBudget(messages: readonly AgentMessage[], budgetTokens: number): { messages: AgentMessage[]; cleared: number } {
	const estimates = messages.map(estimateMessageTokens);
	let total = estimates.reduce((sum, n) => sum + n, 0);
	if (total <= budgetTokens) return { messages: [...messages], cleared: 0 };

	const candidates = estimates
		.map((tokens, index) => ({ index, tokens }))
		.filter(({ index }) => messages[index].role === "toolResult")
		.sort((a, b) => b.tokens - a.tokens || a.index - b.index);

	const out = [...messages];
	let cleared = 0;
	for (const { index, tokens } of candidates) {
		if (total <= budgetTokens) break;
		const replacement = clearToolResult(messages[index]);
		out[index] = replacement;
		total += estimateMessageTokens(replacement) - tokens;
		cleared++;
	}
	return { messages: out, cleared };
}

/**
 * The messages with every assistant `usage` zeroed. pi-ai's `max_tokens` clamp
 * estimates a request from the *last assistant message's usage* plus the
 * messages after it (`estimateContextTokens`), and a usage total describes the
 * request it came from — the session's, with its ~20k of system prompt and
 * tools, the messages before the span, and on an overflow a total already past
 * the window. Anchored on it, a standalone request that fits by content was
 * still clamped to `max_tokens` 1 (measured). Zero usage is skipped by the
 * estimator (it needs a positive total), so the clamp falls back to counting
 * what is actually sent. The replay path keeps its usage: there the numbers
 * describe the very prefix being replayed. Copies; the inputs are untouched.
 */
export function withoutUsage(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => {
		const m = message as { role: string; usage?: unknown };
		if (m.role !== "assistant" || !m.usage) return message;
		const usage = m.usage as { cost?: unknown };
		return {
			...(message as object),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...(usage.cost as object), total: 0 } },
		} as AgentMessage;
	});
}

/** A tool result reduced to its opening text and a note; images are dropped. */
export function clearToolResult(message: AgentMessage): AgentMessage {
	const content = (message as { content?: unknown }).content;
	const blocks = Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [];
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	const head = text.slice(0, CLEARED_RESULT_HEAD_CHARS);
	const omitted = text.length - head.length;
	const images = blocks.length - blocks.filter((block) => block.type === "text").length;
	const note = `[Tool result cleared to fit the compaction request: ${omitted} more characters${
		images > 0 ? ` and ${images} image${images === 1 ? "" : "s"}` : ""
	} omitted. The full result is in the session transcript.]`;
	return {
		...(message as object),
		content: [{ type: "text", text: head ? `${head}\n${note}` : note }],
	} as AgentMessage;
}

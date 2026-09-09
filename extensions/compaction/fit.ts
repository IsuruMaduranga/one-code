/**
 * Which request shape a compaction takes, and how a standalone one is made to
 * fit the window. Pure: no pi extension API, only pi-ai's own estimator.
 *
 * Two shapes exist:
 *
 * - **Replay**: the session's last real request (captured from the `context`
 *   event) plus the instruction. Cache-aligned, so the call is mostly cache
 *   reads — the reason the extension compacts on the session model at all.
 *   It only works while the request leaves room for the summary: pi clamps
 *   `max_tokens` to what the window has left (`clampMaxTokensToContext`), so a
 *   request at or over the window is sent with `max_tokens` 1, or the provider
 *   rejects it outright. Both return nothing usable. An overflow-triggered
 *   compaction is *by definition* in that state (review H2: every overflow
 *   fell through to pi's summary).
 *
 * - **Standalone**: the doomed span alone (what pi is about to discard,
 *   reconstructed from `preparation`), no tools, a one-line system prompt, and
 *   the instruction. It cannot hit the cache, which is moot on an overflowing
 *   request anyway; what it keeps is One Code's summary: the nine sections,
 *   the continuation preamble, and the transcript pointer. Even the doomed
 *   span may not fit — pi keeps only ~20k tokens after the cut, so on an
 *   overflow the span is nearly the whole window — so `fitToBudget` clears
 *   the largest tool results first until the request has room. Their full
 *   text is in the session transcript the summary points at (Claude Code's
 *   own microcompact clears old tool results the same way).
 *
 * Both decisions ask pi-ai's `clampMaxTokensToContext` — the very function
 * `completeSimple` applies to the request — rather than re-deriving its
 * arithmetic, so they can never disagree with the clamp they predict. One
 * trap in that estimator: it anchors on the last assistant message's
 * `usage` total when there is one (`withoutUsage`).
 */

import { type Api, type Context, contentText, type Message, type Model } from "@earendil-works/pi-ai";
import { PREVIEW_BYTES } from "../lib/persisted-output.ts";
// Vendored from pi-ai: importing its deep subpaths directly breaks under the
// bundled app's library loader (distribution review 2026-09-09, H1).
import { clampMaxTokensToContext, estimateMessageTokens } from "../lib/pi-ai-estimate.ts";

/**
 * The least output room a replay must leave for the summary. Below it the
 * clamp truncates the reply (or the request is rejected) and pi's summary
 * would serve instead. With pi's default `reserveTokens` (16 384) a threshold
 * compaction leaves ~12k, comfortably above; an overflow leaves nothing.
 */
export const MIN_REPLAY_SUMMARY_TOKENS = 4096;

/** The output room a standalone request is trimmed to leave for the summary. */
export const STANDALONE_SUMMARY_TOKENS = 8192;

/** How much of a cleared tool result's text is kept as a landmark (persisted-output's preview size). */
export const CLEARED_RESULT_HEAD_CHARS = PREVIEW_BYTES;

/**
 * True when replaying the captured request would leave room for the summary:
 * the `max_tokens` pi will actually send, given this request, is at least the
 * floor. An overflow never replays — the request that just failed *is* the
 * capture, whatever the estimate says.
 */
export function replayFits(reason: "manual" | "threshold" | "overflow", model: Model<Api>, request: Context, maxTokens: number): boolean {
	if (reason === "overflow") return false;
	return clampMaxTokensToContext(model, request, maxTokens) >= MIN_REPLAY_SUMMARY_TOKENS;
}

/**
 * Clears the largest tool results (oldest first on a tie) until pi's clamp
 * would leave `STANDALONE_SUMMARY_TOKENS` of output room, or none are left to
 * clear (then the provider's verdict decides, and pi's summary serves on
 * failure). Nothing but tool results is touched. Returns a new context with
 * new messages — the inputs are never mutated.
 */
export function fitToBudget(model: Model<Api>, request: Context, maxTokens: number): { request: Context; cleared: number } {
	const messages = [...request.messages];
	const fitted: Context = { ...request, messages };
	const candidates = messages
		.map((message, index) => ({ index, tokens: message.role === "toolResult" ? estimateMessageTokens(message) : -1 }))
		.filter(({ tokens }) => tokens >= 0)
		.sort((a, b) => b.tokens - a.tokens || a.index - b.index);

	let cleared = 0;
	for (const { index } of candidates) {
		if (clampMaxTokensToContext(model, fitted, maxTokens) >= STANDALONE_SUMMARY_TOKENS) break;
		messages[index] = clearToolResult(messages[index]);
		cleared++;
	}
	return { request: fitted, cleared };
}

/**
 * The messages with every assistant `usage` zeroed. pi-ai's estimator anchors
 * on the *last assistant message's usage total* plus the messages after it
 * (`estimateContextTokens`), and a usage total describes the request it came
 * from — the session's, with its ~20k of system prompt and tools, the
 * messages before the span, and on an overflow a total already past the
 * window. Anchored on it, a standalone request that fit by content was still
 * clamped to `max_tokens` 1 (measured). Zero usage is skipped by the
 * estimator (it needs a positive total), so the clamp counts what is actually
 * sent. The replay path keeps its usage: there the numbers describe the very
 * prefix being replayed. Copies; the inputs are untouched.
 */
export function withoutUsage(messages: readonly Message[]): Message[] {
	return messages.map((message) =>
		message.role === "assistant" && message.usage
			? { ...message, usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }
			: message,
	);
}

/** A tool result reduced to its opening text and a note; images are dropped. */
export function clearToolResult(message: Message): Message {
	if (message.role !== "toolResult") return message;
	const text = contentText(message.content);
	const head = text.slice(0, CLEARED_RESULT_HEAD_CHARS);
	const omitted = text.length - head.length;
	const images = message.content.filter((block) => block.type !== "text").length;
	const note = `[Tool result cleared to fit the compaction request: ${omitted} more characters${
		images > 0 ? ` and ${images} image${images === 1 ? "" : "s"}` : ""
	} omitted. The full result is in the session transcript.]`;
	return { ...message, content: [{ type: "text", text: head ? `${head}\n${note}` : note }] };
}

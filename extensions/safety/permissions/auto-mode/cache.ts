/** Classifier cache breakpoints on the wire. Never changes classifier text or verdict behavior. */

import { MAX_SIDE_CALL_CACHE_MARKERS } from "../../../lib/side-calls/side-call-cache.ts";
import { isPlainObject } from "../../../lib/core/plain-object.ts";

type WireRecord = Record<string, unknown>;

/**
 * The APIs whose classifier payload carries explicit cache breakpoints on every
 * model that has them: Anthropic Messages, Chat Completions in Anthropic's
 * `cache_control` format (OpenRouter's `anthropic/*`), and Bedrock Converse's
 * `cachePoint` blocks. On these the edit below moves the marker pi-ai placed,
 * and does nothing where there is none.
 */
const MARKER_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "bedrock-converse-stream"]);

/**
 * The most history boundaries marked on an OpenAI Responses request: the first
 * this many, and none after, so the marked set never changes as the history
 * grows. Past it, a call reads the cache up to boundary 1,000 and sends the
 * rest uncached; nothing is rejected. A tested ceiling, not a documented one:
 * GPT-6.1 Terra accepted a request with 1,000 breakpoints (2026-11-15).
 */
export const MAX_RESPONSES_HISTORY_MARKS = 1000;

/**
 * Whether the classifier's payload hook runs for `model`: the marker APIs
 * above, and OpenAI Responses on a model whose catalog entry takes explicit
 * prompt-cache breakpoints (`compat.supportsExplicitPromptCacheMode`, GPT-5.6
 * and later). Those models reuse a cached prefix only at a message end, the end
 * of the leading developer block or an explicit breakpoint, so without one the
 * growing user message is never read back past the system prompt. Every other
 * API (Codex's Responses backend, older OpenAI models) reuses a prefix that
 * ends inside a message and keeps the single string.
 */
export function classifierCarriesBreakpoints(model: { api: string; compat?: unknown }): boolean {
	return MARKER_APIS.has(model.api)
		|| (model.api === "openai-responses" && isPlainObject(model.compat) && model.compat.supportsExplicitPromptCacheMode === true);
}

/**
 * Keep each history entry at a stable block boundary. A single growing history
 * block cannot hit the previous call's shorter block. Mark the history, never
 * the pending action, closing tag or stage instruction: on OpenAI Responses
 * every history entry (below), elsewhere the last one.
 *
 * On the marker shapes (Anthropic's and Bedrock's), also mark the previous
 * call's history boundary when it is still in range. That makes it an explicit lookup even after more than Anthropic's 20-block
 * lookback of new entries. The index is only a cache hint: compaction, a branch
 * switch or different framing naturally misses, never reuses stale text.
 * Two history marks plus pi-ai's system marks (two with OAuth) fit the limit of
 * four. The classifier has no tools and exactly one user message (Chat
 * Completions and Responses put the system prompt in the list beside it). On
 * the marker shapes the marks only use free slots: if pi-ai ever puts more
 * markers on the system or tools, the previous-call mark goes first, then the
 * edit is skipped, so a pi change can cost a cache miss but never a rejected
 * (and so fail-closed) request.
 *
 * pi-ai's user message is one of three shapes, each left alone unless its text
 * is exactly the parts joined (a provider transform, such as removing unpaired
 * surrogates, keeps pi-ai's wire text; caching is optional, the payload is not):
 * - one text block with `cache_control` (Anthropic Messages, and Chat
 *   Completions when the model takes Anthropic's format);
 * - one `{ text }` block then a `{ cachePoint }` block (Bedrock Converse);
 * - one `input_text` part in the `input` list (OpenAI Responses, below).
 *
 * Returns how many parts it marked, or `undefined` when it left the payload
 * alone (for the classifier's probe log; the edit does not depend on it).
 */
export function cacheClassifierHistory(payload: unknown, parts: readonly string[], historyEnd: number, previousEnd?: number): number | undefined {
	if (!isPlainObject(payload)) return undefined;
	if (Array.isArray(payload.input)) return cacheResponsesHistory(payload, payload.input, parts, historyEnd);
	if (!Array.isArray(payload.messages)) return undefined;
	const message = onlyUserMessage(payload.messages);
	if (message === undefined) return undefined;
	const content = message.content;
	if (!Array.isArray(content) || !content.every(isPlainObject)) return undefined;
	const text = parts.join("");
	const marker = anthropicMarker(content, text);
	const point = marker === undefined ? bedrockCachePoint(content, text, parts) : undefined;
	if (marker === undefined && point === undefined) return undefined;
	// The user message's own marker is replaced, so its slot is ours to reuse.
	const free = MAX_SIDE_CALL_CACHE_MARKERS - markersOutside(payload, message);
	if (free < 1) return undefined;
	const markPrevious = free >= 2 && previousEnd !== undefined && previousEnd < historyEnd;
	const marked = (i: number) => i === historyEnd || (markPrevious && i === previousEnd);
	message.content = marker !== undefined
		? parts.map((part, i) => ({ type: "text", text: part, ...(marked(i) ? { cache_control: marker } : {}) }))
		: parts.flatMap((part, i) => [{ text: part }, ...(marked(i) ? [{ cachePoint: point }] : [])]);
	return countMarked(parts, marked);
}

/**
 * OpenAI Responses: one `input_text` part per transcript entry, with
 * `prompt_cache_breakpoint: { mode: "explicit" }` on every history part (each
 * takes the request's `prompt_cache_options.ttl`). A breakpoint is part of the
 * cached prefix (it adds one input token), so an entry stored at a boundary is
 * found only by a request with the same breakpoints before it: the marks are a
 * function of the transcript alone, the same on every call, and the previous
 * call's boundary needs no hint. The API puts nothing between a message's parts
 * (the same input token count either way), so the model reads the same text.
 *
 * What limits remain, and why none can reject the request: the provider
 * creates at most four cache writes per request and drops the rest (a call
 * adding many marked entries at once was accepted, and the next call read its
 * last one); it looks up only the first 2 and latest 50 breakpoints (a call
 * after a jump of 50 or more entries reads back to an early mark; a miss, not
 * an error); and the count of breakpoints stays within MAX_RESPONSES_HISTORY_MARKS.
 * Only when pi-ai sent `prompt_cache_options`, its sign that this request takes
 * those cache fields: it leaves them off on a ChatGPT sign-in, which rejects
 * them. Whether the API takes a blank part is unconfirmed, so parts that would
 * make one keep the single part.
 */
function cacheResponsesHistory(payload: WireRecord, input: unknown[], parts: readonly string[], historyEnd: number): number | undefined {
	if (!isPlainObject(payload.prompt_cache_options) || parts.some((part) => part.trim() === "")) return undefined;
	const message = onlyUserMessage(input);
	if (message === undefined || !Array.isArray(message.content) || message.content.length !== 1) return undefined;
	const [part] = message.content;
	if (!isPlainObject(part) || Object.keys(part).length !== 2 || part.type !== "input_text" || part.text !== parts.join("")) return undefined;
	const marked = (i: number) => i <= historyEnd && i < MAX_RESPONSES_HISTORY_MARKS;
	message.content = parts.map((text, i) => ({ type: "input_text", text, ...(marked(i) ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}) }));
	return countMarked(parts, marked);
}

function countMarked(parts: readonly string[], marked: (i: number) => boolean): number {
	return parts.reduce((count, _part, i) => count + (marked(i) ? 1 : 0), 0);
}

/** The single user message of a list whose other entries are only system or developer instructions. */
function onlyUserMessage(list: unknown[]): WireRecord | undefined {
	const userIndex = list.findIndex((entry) => isPlainObject(entry) && entry.role === "user");
	if (userIndex === -1 || list.some((entry, i) => i !== userIndex && !(isPlainObject(entry) && (entry.role === "system" || entry.role === "developer")))) return undefined;
	return list[userIndex] as WireRecord;
}

/** The marker of a single marked text block holding exactly `text`. */
function anthropicMarker(content: WireRecord[], text: string): unknown {
	const [block] = content;
	return content.length === 1 && block.type === "text" && block.text === text ? block.cache_control : undefined;
}

/**
 * Bedrock's cache point after a single text block holding exactly `text`.
 * Bedrock rejects a blank text block, so parts that would make one keep the
 * single block.
 */
function bedrockCachePoint(content: WireRecord[], text: string, parts: readonly string[]): unknown {
	if (content.length !== 2 || parts.some((part) => part.trim() === "")) return undefined;
	const [block, point] = content;
	return Object.keys(block).length === 1 && block.text === text && Object.keys(point).length === 1 ? point.cachePoint : undefined;
}

/** Breakpoints elsewhere in the request: the tools, the system prompt and any instruction message. */
function markersOutside(payload: WireRecord, message: WireRecord): number {
	const count = (value: unknown) => (Array.isArray(value) ? value.filter((block) => isPlainObject(block) && (block.cache_control !== undefined || block.cachePoint !== undefined)).length : 0);
	const toolConfig = isPlainObject(payload.toolConfig) ? payload.toolConfig.tools : undefined;
	const others = (payload.messages as unknown[]).filter((entry) => entry !== message);
	return count(payload.tools) + count(toolConfig) + count(payload.system) + others.reduce<number>((sum, entry) => sum + (isPlainObject(entry) ? count(entry.content) : 0), 0);
}


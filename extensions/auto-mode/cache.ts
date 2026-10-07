/** Classifier cache breakpoints on the wire. Never changes classifier text or verdict behavior. */

import { MAX_SIDE_CALL_CACHE_MARKERS } from "../lib/side-call-cache.ts";

type WireRecord = Record<string, unknown>;

/**
 * The APIs whose classifier payload carries explicit cache breakpoints:
 * Anthropic Messages, Chat Completions in Anthropic's `cache_control` format
 * (OpenRouter's `anthropic/*`), and Bedrock Converse's `cachePoint` blocks.
 * Any other API caches by prefix on its own, and the edit below finds no
 * marker there and does nothing.
 */
export const CLASSIFIER_CACHE_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "bedrock-converse-stream"]);

/**
 * Keep each history entry at a stable block boundary. A single growing history
 * block cannot hit the previous call's shorter block. Mark the last history
 * entry, not the pending action, closing tag or stage instruction.
 *
 * Also mark the previous call's history boundary when it is still in range.
 * That makes it an explicit lookup even after more than Anthropic's 20-block
 * lookback of new entries. The index is only a cache hint: compaction, a branch
 * switch or different framing naturally misses, never reuses stale text.
 * Two history marks plus pi-ai's system marks (two with OAuth) fit the limit of
 * four. The classifier has no tools and exactly one user message (Chat
 * Completions puts the system prompt in the list beside it). The marks only use
 * free slots: if pi-ai ever puts more markers on the system or tools, the
 * previous-call mark goes first, then the edit is skipped, so a pi change can
 * cost a cache miss but never a rejected (and so fail-closed) request.
 *
 * pi-ai's user message is one of two shapes, each left alone unless its text is
 * exactly the parts joined (a provider transform, such as removing unpaired
 * surrogates, keeps pi-ai's wire text; caching is optional, the payload is not):
 * - one text block with `cache_control` (Anthropic Messages, and Chat
 *   Completions when the model takes Anthropic's format);
 * - one `{ text }` block then a `{ cachePoint }` block (Bedrock Converse).
 */
export function cacheClassifierHistory(payload: unknown, parts: readonly string[], historyEnd: number, previousEnd?: number): void {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return;
	const messages = payload.messages;
	const userIndex = messages.findIndex((message) => isRecord(message) && message.role === "user");
	if (userIndex === -1 || messages.some((message, i) => i !== userIndex && !(isRecord(message) && (message.role === "system" || message.role === "developer")))) return;
	const message = messages[userIndex] as WireRecord;
	const content = message.content;
	if (!Array.isArray(content) || !content.every(isRecord)) return;
	const text = parts.join("");
	const marker = anthropicMarker(content, text);
	const point = marker === undefined ? bedrockCachePoint(content, text, parts) : undefined;
	if (marker === undefined && point === undefined) return;
	// The user message's own marker is replaced, so its slot is ours to reuse.
	const free = MAX_SIDE_CALL_CACHE_MARKERS - markersOutside(payload, message);
	if (free < 1) return;
	const markPrevious = free >= 2 && previousEnd !== undefined && previousEnd < historyEnd;
	const marked = (i: number) => i === historyEnd || (markPrevious && i === previousEnd);
	message.content = marker !== undefined
		? parts.map((part, i) => ({ type: "text", text: part, ...(marked(i) ? { cache_control: marker } : {}) }))
		: parts.flatMap((part, i) => [{ text: part }, ...(marked(i) ? [{ cachePoint: point }] : [])]);
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
	const count = (value: unknown) => (Array.isArray(value) ? value.filter((block) => isRecord(block) && (block.cache_control !== undefined || block.cachePoint !== undefined)).length : 0);
	const toolConfig = isRecord(payload.toolConfig) ? payload.toolConfig.tools : undefined;
	const others = (payload.messages as unknown[]).filter((entry) => entry !== message);
	return count(payload.tools) + count(toolConfig) + count(payload.system) + others.reduce<number>((sum, entry) => sum + (isRecord(entry) ? count(entry.content) : 0), 0);
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

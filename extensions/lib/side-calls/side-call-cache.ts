/**
 * Cache placement for standalone side calls. pi-ai marks the final user
 * question, which means every different question writes a fresh cache entry.
 * Move that marker onto the preceding conversation message instead, without
 * changing any message text. Call this from the payload hook of:
 *
 * - `anthropic-messages`: a `cache_control` field on a content block;
 * - `openai-completions`: the same `cache_control` markers when the model takes
 *   Anthropic's format (OpenRouter's `anthropic/*`), and none to move otherwise;
 * - `bedrock-converse-stream`: a `{ cachePoint }` block after the content it
 *   closes (pi-ai adds one to the last user message of a Claude model), and
 *   none on other models.
 *
 * What counts as a marker (`isCachePoint`, `payloadMarkers`) is shared with the
 * auto-mode classifier's own placement (safety/permissions/auto-mode/cache.ts)
 * and the ledger's wire comparison (lib/request/ledger/wire.ts).
 */

import { isPlainObject } from "../core/plain-object.ts";

/** The APIs whose standalone side-call payload this placement applies to. */
export const SIDE_CALL_CACHE_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "bedrock-converse-stream"]);

/** Anthropic permits at most four cache-control markers per request, and Bedrock four cache points. */
export const MAX_SIDE_CALL_CACHE_MARKERS = 4;

type WireRecord = Record<string, unknown>;

/** A Bedrock Converse cache point: a block that holds `cachePoint` and nothing else. */
export function isCachePoint(block: unknown): block is { cachePoint: unknown } {
	return isPlainObject(block) && block.cachePoint !== undefined && Object.keys(block).length === 1;
}

/**
 * Move pi-ai's final-question cache marker to the last preceding message and
 * remove the earliest markers past Anthropic's four-marker limit. Unsupported
 * payload shapes are left unchanged rather than being normalised.
 */
export function cacheSideCallConversation(payload: unknown): void {
	if (!isPlainObject(payload) || !Array.isArray(payload.messages)) return;
	const messages = payload.messages;
	const questionIndex = messages.length - 1;
	const question = asMessage(messages[questionIndex]);
	if (!question || question.role !== "user") return;
	const questionBlocks = blocks(question.content);
	if (questionBlocks.some(isCachePoint)) {
		moveCachePoint(payload, messages, questionIndex, questionBlocks);
		return;
	}
	const sourceIndex = questionBlocks.findLastIndex((block) => block.cache_control !== undefined);
	if (sourceIndex === -1) return;

	const target = precedingBlock(messages, questionIndex, isCacheableBlock);
	if (!target) return;
	const { cache_control: marker, ...unmarked } = questionBlocks[sourceIndex];
	const nextTargetBlocks = target.blocks.with(target.blockIndex, { ...target.blocks[target.blockIndex], cache_control: marker });
	commit(payload, messages, questionIndex, questionBlocks.with(sourceIndex, unmarked), target, nextTargetBlocks);
}

/**
 * Bedrock: move the question's cache point to just after the last block of a
 * preceding message that a cache point may close, keeping every block's text.
 */
function moveCachePoint(payload: WireRecord, messages: unknown[], questionIndex: number, questionBlocks: WireRecord[]): void {
	const sourceIndex = questionBlocks.findLastIndex(isCachePoint);
	const target = precedingBlock(messages, questionIndex, isBedrockCacheableBlock);
	if (!target) return;
	const point = questionBlocks[sourceIndex];
	const alreadyClosed = isCachePoint(target.blocks[target.blockIndex + 1]);
	const nextTargetBlocks = alreadyClosed ? target.blocks : target.blocks.toSpliced(target.blockIndex + 1, 0, point);
	commit(payload, messages, questionIndex, questionBlocks.toSpliced(sourceIndex, 1), target, nextTargetBlocks);
}

interface Target {
	messageIndex: number;
	message: WireRecord;
	blocks: WireRecord[];
	blockIndex: number;
}

/** Put the question's and the target's new content into a copy of the message list, then cap the markers. */
function commit(payload: WireRecord, messages: unknown[], questionIndex: number, questionBlocks: WireRecord[], target: Target, targetBlocks: WireRecord[]): void {
	const nextMessages = [...messages];
	nextMessages[questionIndex] = { ...asMessage(messages[questionIndex]), content: questionBlocks };
	nextMessages[target.messageIndex] = { ...target.message, content: targetBlocks };
	payload.messages = nextMessages;
	capMarkers(payload);
}

/** The last block before the question that `cacheable` says a marker may close. */
function precedingBlock(messages: unknown[], questionIndex: number, cacheable: (block: WireRecord) => boolean): Target | undefined {
	for (let messageIndex = questionIndex - 1; messageIndex >= 0; messageIndex--) {
		const message = asMessage(messages[messageIndex]);
		if (!message) continue;
		// pi-ai keeps earlier user text as a string, only converting the final
		// marked message to blocks. Convert this target exactly as pi-ai does so
		// the newest conversation turn, rather than an older block message, gets
		// the cache boundary. The text itself remains byte-for-byte unchanged.
		// Chat Completions also sends assistant and tool text as strings; an
		// empty one (a tool-call-only reply) cannot carry a marker, as in pi-ai.
		// Bedrock content is always a block list.
		if (typeof message.content === "string") {
			if (message.content.length === 0) continue;
			return { messageIndex, message, blocks: [{ type: "text", text: message.content }], blockIndex: 0 };
		}
		const content = blocks(message.content);
		const blockIndex = content.findLastIndex(cacheable);
		if (blockIndex !== -1) return { messageIndex, message, blocks: content, blockIndex };
	}
	return undefined;
}

function asMessage(value: unknown): WireRecord | undefined {
	return isPlainObject(value) && typeof value.role === "string" ? value : undefined;
}

function blocks(value: unknown): WireRecord[] {
	return Array.isArray(value) && value.every(isPlainObject) ? value : [];
}

/** A block Anthropic accepts as a message cache breakpoint: pi-ai's own list from its Anthropic message converter. */
function isCacheableBlock(block: WireRecord): boolean {
	return (
		block.type === "text" ||
		block.type === "image" ||
		block.type === "tool_result" ||
		block.type === "tool_addition" ||
		block.type === "tool_removal"
	);
}

/** A Bedrock block a cache point may follow: text that is not blank, an image or a tool result, the Bedrock forms of `isCacheableBlock`. */
function isBedrockCacheableBlock(block: WireRecord): boolean {
	return (typeof block.text === "string" && block.text.trim() !== "") || block.image !== undefined || block.toolResult !== undefined;
}

/** One cache marker: the message whose content holds it (none for a tool or system marker), and how to take it off. */
export interface CacheMarker {
	message?: WireRecord;
	/** Delete an Anthropic `cache_control` field, or remove a Bedrock cache point from its list. */
	remove: () => void;
}

/**
 * Every cache marker of a payload, in wire order: the tool definitions
 * (Bedrock's under `toolConfig`), the top-level system blocks, then each
 * message's content blocks. Never inspects block payloads.
 */
export function payloadMarkers(payload: WireRecord): CacheMarker[] {
	const toolConfig = isPlainObject(payload.toolConfig) ? payload.toolConfig : undefined;
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	return [
		...listMarkers(payload.tools),
		...listMarkers(toolConfig?.tools),
		...listMarkers(payload.system),
		...messages.flatMap((message) => (isPlainObject(message) && Array.isArray(message.content) ? listMarkers(message.content, message) : [])),
	];
}

/** Drop the earliest markers in wire order past the limit of four. */
function capMarkers(payload: WireRecord): void {
	const markers = payloadMarkers(payload);
	const excess = markers.slice(0, Math.max(0, markers.length - MAX_SIDE_CALL_CACHE_MARKERS));
	// Remove from the end of each list first, so an earlier cache point's index stays valid.
	for (const marker of excess.reverse()) marker.remove();
}

/** The markers of a block list (tool definitions, top-level system blocks, a message's content). */
function listMarkers(value: unknown, message?: WireRecord): CacheMarker[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry, index): CacheMarker[] => {
		if (isCachePoint(entry)) return [{ message, remove: () => value.splice(index, 1) }];
		if (!isPlainObject(entry) || entry.cache_control === undefined) return [];
		return [{ message, remove: () => delete entry.cache_control }];
	});
}

/** The conversation cache placement a side call passes to `runSideCall` (`side-call-run.ts`). */
export const CONVERSATION_CACHE_PLACEMENT = { apis: SIDE_CALL_CACHE_APIS, place: cacheSideCallConversation } as const;

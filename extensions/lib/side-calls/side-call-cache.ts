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
 * What counts as a marker (`isCacheMarker`) is shared with the auto-mode
 * classifier's own placement (safety/permissions/auto-mode/cache.ts).
 */

import { isPlainObject } from "../core/plain-object.ts";

/** The APIs whose standalone side-call payload this placement applies to. */
export const SIDE_CALL_CACHE_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "bedrock-converse-stream"]);

/** Anthropic permits at most four cache-control markers per request, and Bedrock four cache points. */
export const MAX_SIDE_CALL_CACHE_MARKERS = 4;

type WireRecord = Record<string, unknown>;

/** A cache breakpoint on the wire: an Anthropic-format `cache_control` field, or a Bedrock `{ cachePoint }` block. */
export function isCacheMarker(block: unknown): boolean {
	return isPlainObject(block) && (block.cache_control !== undefined || block.cachePoint !== undefined);
}

/** A Bedrock Converse cache point: a block that holds `cachePoint` and nothing else. */
function isCachePoint(block: WireRecord): boolean {
	return block.cachePoint !== undefined && Object.keys(block).length === 1;
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

	const target = precedingCacheableBlock(messages, questionIndex);
	if (!target) return;
	const marker = questionBlocks[sourceIndex].cache_control;
	const nextQuestionBlocks = [...questionBlocks];
	const { cache_control: _, ...unmarked } = questionBlocks[sourceIndex];
	nextQuestionBlocks[sourceIndex] = unmarked;
	const nextTargetBlocks = [...target.blocks];
	nextTargetBlocks[target.blockIndex] = { ...target.blocks[target.blockIndex], cache_control: marker };
	const nextMessages = [...messages];
	nextMessages[questionIndex] = { ...question, content: nextQuestionBlocks };
	nextMessages[target.messageIndex] = { ...target.message, content: nextTargetBlocks };
	payload.messages = nextMessages;
	capMarkers(payload);
}

/**
 * Bedrock: move the question's cache point to just after the last block of a
 * preceding message that a cache point may close, keeping every block's text.
 */
function moveCachePoint(payload: WireRecord, messages: unknown[], questionIndex: number, questionBlocks: WireRecord[]): void {
	const sourceIndex = questionBlocks.findLastIndex(isCachePoint);
	const target = precedingBedrockBlock(messages, questionIndex);
	if (!target) return;
	const point = questionBlocks[sourceIndex];
	const nextMessages = [...messages];
	nextMessages[questionIndex] = { ...asMessage(messages[questionIndex]), content: questionBlocks.filter((_, index) => index !== sourceIndex) };
	const after = target.blocks[target.blockIndex + 1];
	const alreadyClosed = after !== undefined && isCachePoint(after);
	const nextTargetBlocks = alreadyClosed ? target.blocks : [...target.blocks.slice(0, target.blockIndex + 1), point, ...target.blocks.slice(target.blockIndex + 1)];
	nextMessages[target.messageIndex] = { ...target.message, content: nextTargetBlocks };
	payload.messages = nextMessages;
	capMarkers(payload);
}

/**
 * The last prior Bedrock block a cache point may follow: text that is not
 * blank, an image or a tool result, the Bedrock forms of pi-ai's Anthropic list
 * (`isCacheableBlock`). Bedrock content is always a block list.
 */
function precedingBedrockBlock(messages: unknown[], questionIndex: number): Target | undefined {
	for (let messageIndex = questionIndex - 1; messageIndex >= 0; messageIndex--) {
		const message = asMessage(messages[messageIndex]);
		if (!message) continue;
		const content = blocks(message.content);
		const blockIndex = content.findLastIndex((block) => (typeof block.text === "string" && block.text.trim() !== "") || block.image !== undefined || block.toolResult !== undefined);
		if (blockIndex !== -1) return { messageIndex, message, blocks: content, blockIndex };
	}
	return undefined;
}

interface Target {
	messageIndex: number;
	message: WireRecord;
	blocks: WireRecord[];
	blockIndex: number;
}

/** The last prior wire block Anthropic accepts as a message cache breakpoint. */
function precedingCacheableBlock(messages: unknown[], questionIndex: number): Target | undefined {
	for (let messageIndex = questionIndex - 1; messageIndex >= 0; messageIndex--) {
		const message = asMessage(messages[messageIndex]);
		if (!message) continue;
		// pi-ai keeps earlier user text as a string, only converting the final
		// marked message to blocks. Convert this target exactly as pi-ai does so
		// the newest conversation turn, rather than an older block message, gets
		// the cache boundary. The text itself remains byte-for-byte unchanged.
		// Chat Completions also sends assistant and tool text as strings; an
		// empty one (a tool-call-only reply) cannot carry a marker, as in pi-ai.
		if (typeof message.content === "string") {
			if (message.content.length === 0) continue;
			return { messageIndex, message, blocks: [{ type: "text", text: message.content }], blockIndex: 0 };
		}
		const content = blocks(message.content);
		const blockIndex = content.findLastIndex(isCacheableBlock);
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

/** This is pi-ai's own list from its Anthropic message converter. */
function isCacheableBlock(block: WireRecord): boolean {
	return (
		block.type === "text" ||
		block.type === "image" ||
		block.type === "tool_result" ||
		block.type === "tool_addition" ||
		block.type === "tool_removal"
	);
}

/** One marker and how to take it off: delete an Anthropic field, or remove a Bedrock cache point from its list. */
interface Marker {
	remove: () => void;
}

/** Drop the earliest markers in wire order (tools, system, messages) past the limit of four. */
function capMarkers(payload: WireRecord): void {
	const toolConfig = isPlainObject(payload.toolConfig) ? payload.toolConfig : undefined;
	const markers = [
		...listMarkers(payload.tools),
		...listMarkers(toolConfig?.tools),
		...listMarkers(payload.system),
		...messageMarkers(payload.messages),
	];
	const excess = markers.slice(0, Math.max(0, markers.length - MAX_SIDE_CALL_CACHE_MARKERS));
	// Remove from the end of each list first, so an earlier cache point's index stays valid.
	for (const marker of excess.reverse()) marker.remove();
}

/** The markers of a block list (tool definitions, top-level system blocks, a message's content). Never inspect block payloads. */
function listMarkers(value: unknown): Marker[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry, index): Marker[] => {
		if (!isPlainObject(entry)) return [];
		if (isCachePoint(entry)) return [{ remove: () => value.splice(index, 1) }];
		return entry.cache_control !== undefined ? [{ remove: () => delete entry.cache_control }] : [];
	});
}

/** Only a message content block is a conversation marker. */
function messageMarkers(value: unknown): Marker[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((message) => (isPlainObject(message) && Array.isArray(message.content) ? listMarkers(message.content) : []));
}



/** The conversation cache placement a side call passes to `runSideCall` (`side-call-run.ts`). */
export const CONVERSATION_CACHE_PLACEMENT = { apis: SIDE_CALL_CACHE_APIS, place: cacheSideCallConversation } as const;

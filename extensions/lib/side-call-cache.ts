/**
 * Anthropic cache placement for standalone side calls. pi-ai marks the final
 * user question, which means every different question writes a fresh cache
 * entry. Move that marker onto the preceding conversation message instead,
 * without changing any message text. Call this only from an
 * `anthropic-messages` payload hook.
 */

/** Anthropic permits at most four cache-control markers per request. */
export const MAX_SIDE_CALL_CACHE_MARKERS = 4;

type WireRecord = Record<string, unknown>;

/**
 * Move pi-ai's final-question cache marker to the last preceding message and
 * remove the earliest markers past Anthropic's four-marker limit. Unsupported
 * payload shapes are left unchanged rather than being normalised.
 */
export function cacheSideCallConversation(payload: unknown): void {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return;
	const messages = payload.messages;
	const questionIndex = messages.length - 1;
	const question = asMessage(messages[questionIndex]);
	if (!question || question.role !== "user") return;
	const questionBlocks = blocks(question.content);
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
		if (typeof message.content === "string") {
			return { messageIndex, message, blocks: [{ type: "text", text: message.content }], blockIndex: 0 };
		}
		const content = blocks(message.content);
		const blockIndex = content.findLastIndex(isCacheableBlock);
		if (blockIndex !== -1) return { messageIndex, message, blocks: content, blockIndex };
	}
	return undefined;
}

function asMessage(value: unknown): WireRecord | undefined {
	return isRecord(value) && typeof value.role === "string" ? value : undefined;
}

function blocks(value: unknown): WireRecord[] {
	return Array.isArray(value) && value.every(isRecord) ? value : [];
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

/** Drop the earliest actual Anthropic markers in wire order: tools, system, messages. */
function capMarkers(payload: WireRecord): void {
	const markers = [
		...topLevelMarkers(payload.tools),
		...topLevelMarkers(payload.system),
		...messageMarkers(payload.messages),
	];
	for (const marker of markers.slice(0, Math.max(0, markers.length - MAX_SIDE_CALL_CACHE_MARKERS))) delete marker.cache_control;
}

/** Markers pi-ai put on the tools and the system prompt: what a message breakpoint must leave room for. */
export function topLevelMarkerCount(payload: unknown): number {
	return isRecord(payload) ? topLevelMarkers(payload.tools).length + topLevelMarkers(payload.system).length : 0;
}

/** Tool definitions and top-level system blocks can each carry one marker. */
function topLevelMarkers(value: unknown): WireRecord[] {
	return Array.isArray(value) ? value.filter((entry): entry is WireRecord => isRecord(entry) && entry.cache_control !== undefined) : [];
}

/** Only a message content block is an Anthropic conversation marker. Never inspect block payloads. */
function messageMarkers(value: unknown): WireRecord[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((message) => (isRecord(message) ? blocks(message.content).filter((block) => block.cache_control !== undefined) : []));
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}


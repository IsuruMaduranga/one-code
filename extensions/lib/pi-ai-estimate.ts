/**
 * Vendored token-estimation and max-tokens clamp helpers from pi-ai.
 *
 * The compaction extension needs `clampMaxTokensToContext` (from pi-ai's
 * `api/simple-options`) and `estimateMessageTokens` (from `utils/estimate`) to
 * predict the exact `max_tokens` pi's `completeSimple` will send. Importing
 * those deep subpaths directly breaks under the bundled app: pi's extension
 * loader takes an `alias` branch when pi is imported as a library (not the CLI),
 * and jiti aliases match `@earendil-works/pi-ai` by prefix, rewriting every
 * `@earendil-works/pi-ai/<subpath>` onto pi-ai's compat entry — so
 * `@earendil-works/pi-ai/api/simple-options` resolves to the nonexistent
 * `compat.js/api/simple-options` and the app cannot load the extension set
 * (distribution review 2026-09-09, H1). Only the bare specifier and `/compat`,
 * `/oauth`, `/providers/all` are aliased exactly; every other subpath is dead
 * under the app.
 *
 * So the two consumed helpers (`clampMaxTokensToContext`, `estimateMessageTokens`)
 * and the private estimator chain they depend on are copied here from pi-ai
 * 0.86.1, importing from the bare specifier only types plus `getSystemMessageText`
 * (which pi-ai re-exports from its entry point, so it needs no vendoring — unlike
 * the estimate/clamp helpers under `/utils/estimate` and `/api/simple-options`,
 * which have no bare re-export). The two exported helpers
 * are byte-identical to upstream; the one adaptation is the internal
 * `estimateContextTokens`, narrowed to accept only `Context` (the sole shape we
 * call it with) rather than upstream's `Context | Message[]` overload — the
 * Message[] branch would be dead code here. `test/unit/pi-ai-estimate.test.ts`
 * imports the real deep paths from node_modules and asserts the two exported
 * helpers produce identical numbers, so an upstream change is caught rather than
 * silently drifting.
 *
 * pi 0.86.1 changes re-vendored here (from 0.85.0): the `Message` union gained a
 * `SystemMessage` (its prompt text, `toolsAdded`, and `toolsRemoved` now ride the
 * transcript, so `estimateMessageTokens` has a `system` branch that calls pi-ai's
 * `getSystemMessageText`); `addedToolNames` was removed
 * from `ToolResultMessage`; and `estimateContextTokens` no longer adds
 * `context.systemPrompt`/`context.tools` separately — it sums the messages alone,
 * counting the prompt and tools through any `SystemMessage` present.
 *
 * Caller implication: pi's `completeSimple`/`streamSimple` run `normalizeContext`
 * (folding `systemPrompt`/`tools` into a leading `SystemMessage`) BEFORE the
 * clamp, but the compaction extension calls the vendored clamp with a RAW
 * `Context`, whose `systemPrompt`/`tools` fields are therefore not counted. This
 * is immaterial for both compaction callers. The replay path keeps its captured
 * usage (the usage-anchored branch runs, and the prompt is inside the usage
 * total, never added separately); the standalone path carries a ~36-token system
 * prompt and no tools. A future caller passing a raw `Context` with a large
 * prompt or tools that needs an exact prediction should normalize it first.
 */

import { getSystemMessageText, type Api, type Context, type ImageContent, type Message, type Model, type TextContent, type Usage } from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let chars = 0;
	if (message.role === "system") {
		return estimateTextTokens(getSystemMessageText(message)) + estimateToolsTokens(message.toolsAdded) + estimateToolsTokens(message.toolsRemoved);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);
	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	return usageInfo;
}

function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

// Accepts `Tool[]` (`toolsAdded`) or `ToolReference[]` (`toolsRemoved`); pi's own
// helper only JSON-stringifies, so the element shape is immaterial.
function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

// pi 0.86.1: the prompt and tool declarations ride the transcript as system
// messages, so this sums the messages alone — no separate systemPrompt/tools
// term, and no `addedToolNames` accounting (both gone upstream).
function estimateContextTokens(context: Context): ContextUsageEstimate {
	return estimateMessages(context.messages);
}

export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

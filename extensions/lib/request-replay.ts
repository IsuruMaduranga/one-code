/**
 * Replaying the session's last provider request with a few messages appended,
 * so a side call (btw, recap, compaction) reads the prompt cache the session
 * wrote. Claude Code sends these calls the same way: the main request's
 * `system`, `tools` and `messages` unchanged, the final assistant reply, then
 * the side prompt (docs/decisions/caching.md "Side calls replay the last
 * request").
 *
 * The request cannot be rebuilt from pi's APIs: tool-search reshapes the wire
 * `tools` array and context-management edits the body inside pi's request
 * pipeline, which `completeSimple` bypasses, and one differing byte in `tools`
 * or `system` misses the whole cache. So the compaction extension (the last to
 * see `before_provider_request`) publishes the final payload on
 * LAST_REQUEST_CHANNEL, and a side call sends it back with its tail spliced on
 * through `completeSimple`'s `onPayload`. pi-ai converts the tail itself (the
 * call's own context is just the tail), so its wire shape matches the rest by
 * construction.
 *
 * Pure: no pi extension API; only pi-ai types and the vendored estimator.
 */

import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "./pi-ai-estimate.ts";

/** The compaction extension publishes a RequestCapture here, or undefined when none is valid. */
export const LAST_REQUEST_CHANNEL = "one-code:last-request";

/** The provider APIs whose request body can be extended by appending to one list. */
export type ReplayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

const LIST_KEY: Record<ReplayApi, string> = {
	"anthropic-messages": "messages",
	"openai-completions": "messages",
	"openai-responses": "input",
};

/** The output cap's field, first match in the captured body wins. */
const MAX_TOKEN_KEYS: Record<ReplayApi, readonly string[]> = {
	"anthropic-messages": ["max_tokens"],
	"openai-completions": ["max_completion_tokens", "max_tokens"],
	"openai-responses": ["max_output_tokens"],
};

/** The session's last provider request body, and the model it went to. */
export interface RequestCapture {
	api: ReplayApi;
	provider: string;
	modelId: string;
	payload: Record<string, unknown>;
}

interface ModelRef {
	api?: string;
	provider?: string;
	id?: string;
}

/** A capture of `payload` for `model`, or undefined when its API cannot be replayed. */
export function captureRequest(model: ModelRef | undefined, payload: unknown): RequestCapture | undefined {
	const api = model?.api;
	if (api !== "anthropic-messages" && api !== "openai-completions" && api !== "openai-responses") return undefined;
	if (!model?.provider || !model.id || !isRecord(payload) || !Array.isArray(payload[LIST_KEY[api]])) return undefined;
	return { api, provider: model.provider, modelId: model.id, payload };
}

interface MessageLike {
	role: string;
	content?: unknown;
	stopReason?: string;
}

/**
 * The last captured request plus the assistant reply that answered it, as one
 * consumer extension sees them. The reply is kept only when it closes the
 * exchange cleanly: an errored or aborted reply is omitted from pi's context,
 * and one that called tools is still waiting on their results (appending it
 * without them is invalid on every provider), so both leave the tail empty.
 */
export class LastExchange<Reply extends MessageLike = MessageLike> {
	private capture: RequestCapture | undefined;
	private reply: Reply | undefined;

	/** A new request (or undefined: none valid) replaces the old one and its reply. */
	setCapture(capture: RequestCapture | undefined): void {
		this.capture = capture;
		this.reply = undefined;
	}

	/** Feed every main-session `message_end`; only assistant messages matter. */
	noteMessage(message: Reply): void {
		if (!this.capture || message.role !== "assistant") return;
		const content = Array.isArray(message.content) ? (message.content as { type?: string }[]) : [];
		const clean = message.stopReason !== "error" && message.stopReason !== "aborted" && !content.some((block) => block.type === "toolCall");
		this.reply = clean ? message : undefined;
	}

	/** The capture and reply when the capture went to `model`; a switched model has its own cache. */
	forModel(model: ModelRef | undefined): { capture: RequestCapture; reply: Reply | undefined } | undefined {
		const capture = this.capture;
		if (!capture || capture.provider !== model?.provider || capture.modelId !== model?.id) return undefined;
		return { capture, reply: this.reply };
	}
}

/**
 * The captured body with `tail`'s message list (a body pi-ai built for the tail
 * alone) appended, every other field kept byte for byte. `maxTokens` replaces
 * the output cap when given.
 *
 * Anthropic cache breakpoints: the tail's own markers are dropped, and when the
 * tail starts with the assistant reply, the markers on the captured request's
 * last message move to the reply's last text block (Claude Code's placement).
 * The marker count never grows (the API allows four), the prefix the session
 * cached is read through the lookback, and the reply gets written for the
 * user's next turn. A tail that starts with a user message is merged into a
 * trailing user message, so the roles still alternate.
 */
export function extendPayload(capture: RequestCapture, tail: Record<string, unknown>, maxTokens?: number): Record<string, unknown> {
	const key = LIST_KEY[capture.api];
	const base = capture.payload[key] as unknown[];
	const extra = withoutCacheControl(Array.isArray(tail[key]) ? (tail[key] as unknown[]) : []) as unknown[];
	const list = capture.api === "anthropic-messages" ? appendAnthropic(base, extra) : [...base, ...extra];
	const out: Record<string, unknown> = { ...capture.payload, [key]: list };
	if (maxTokens !== undefined) {
		const keys = MAX_TOKEN_KEYS[capture.api];
		out[keys.find((k) => k in capture.payload) ?? keys[0]] = maxTokens;
	}
	return out;
}

/** The output cap the captured body carries, if any. */
function capturedMaxTokens(capture: RequestCapture): number | undefined {
	for (const key of MAX_TOKEN_KEYS[capture.api]) {
		const value = capture.payload[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

/** A replay that would leave less output room than this is not sent as a replay. */
export const MIN_REPLAY_OUTPUT_TOKENS = 1024;
/** The output cap when neither the captured body nor the caller names one. */
const DEFAULT_REPLAY_OUTPUT_TOKENS = 8192;

/**
 * The messages a side call appends: the reply that closed the exchange, if
 * any, then `before` (a side session's earlier exchanges), then its prompt.
 */
export function replayTail(reply: Message | undefined, prompt: string, timestamp = Date.now(), before: readonly Message[] = []): Message[] {
	const question: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp };
	return [...(reply ? [reply] : []), ...before, question];
}

/**
 * The output cap for a replay, or undefined when too little room is left. The
 * captured cap was clamped to what that request left of the window, and the
 * tail spends some of it; `limit` caps it further.
 */
export function replayOutputCap(capture: RequestCapture, tail: readonly Message[], limit?: number): number | undefined {
	const captured = capturedMaxTokens(capture);
	const room = captured === undefined ? (limit ?? DEFAULT_REPLAY_OUTPUT_TOKENS) : captured - tail.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	const cap = limit === undefined ? room : Math.min(limit, room);
	return cap >= MIN_REPLAY_OUTPUT_TOKENS ? cap : undefined;
}

type Block = Record<string, unknown>;
type WireMessage = { role?: string; content?: unknown } & Record<string, unknown>;

function appendAnthropic(base: unknown[], extra: unknown[]): unknown[] {
	if (extra.length === 0) return base;
	const last = base.at(-1) as WireMessage | undefined;
	const first = extra[0] as WireMessage;
	if (last && first.role === "assistant") {
		const markers = blocksOf(last.content).map((block) => block.cache_control).filter((marker) => marker !== undefined);
		const replyBlocks = blocksOf(first.content);
		const anchor = replyBlocks.findLastIndex((block) => block.type === "text");
		if (markers.length === 0 || anchor === -1) return [...base, ...extra];
		const lastUnmarked = { ...last, content: blocksOf(last.content).map(({ cache_control: _, ...rest }) => rest) };
		const content = replyBlocks.map((block, index) => (index === anchor ? { ...block, cache_control: markers.at(-1) } : block));
		return [...base.slice(0, -1), lastUnmarked, { ...first, content }, ...extra.slice(1)];
	}
	if (last && last.role === "user" && first.role === "user") {
		return [...base.slice(0, -1), { ...last, content: [...blocksOf(last.content), ...blocksOf(first.content)] }, ...extra.slice(1)];
	}
	return [...base, ...extra];
}

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "cache_control") out[key] = withoutCacheControl(entry);
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

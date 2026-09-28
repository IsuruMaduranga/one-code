/**
 * Replaying the session's last provider request with a few messages appended,
 * so a side call (btw, recap, compaction) reads the prompt cache the session
 * wrote. Claude Code sends these calls the same way: the main request's
 * `system`, `tools` and `messages` unchanged, the final assistant reply, then
 * the side prompt (working-docs/decisions/caching.md "Side calls replay the last
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
	/** The last message of the context the body was built from: where a fork's own messages start. */
	covers?: CoveredThrough;
}

/** A transcript message named by what survives a session fork: its role and timestamp. */
export interface CoveredThrough {
	role: string;
	timestamp: number;
}

interface ModelRef {
	api?: string;
	provider?: string;
	id?: string;
}

/** A capture of `payload` for `model`, or undefined when its API cannot be replayed. */
export function captureRequest(model: ModelRef | undefined, payload: unknown, covers?: CoveredThrough): RequestCapture | undefined {
	const api = model?.api;
	if (api !== "anthropic-messages" && api !== "openai-completions" && api !== "openai-responses") return undefined;
	if (!model?.provider || !model.id || !isRecord(payload) || !Array.isArray(payload[LIST_KEY[api]])) return undefined;
	return { api, provider: model.provider, modelId: model.id, payload, ...(covers ? { covers } : {}) };
}

/** The last non-system message of a context, as a fork will find it again; undefined without one. */
export function lastCovered(messages: readonly { role: string; timestamp?: number }[]): CoveredThrough | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const { role, timestamp } = messages[index];
		if (role === "system") continue;
		return typeof timestamp === "number" ? { role, timestamp } : undefined;
	}
	return undefined;
}

/** True when `model` is the one `capture` went to: a different model has a different cache. */
export function captureMatches(capture: RequestCapture, model: ModelRef | undefined): boolean {
	return capture.api === model?.api && capture.provider === model?.provider && capture.modelId === model?.id;
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

// ---------------------------------------------------------------------------
// Forks: every request of a child session that inherits the transcript
// ---------------------------------------------------------------------------

/**
 * A fork's context with the messages its parent's captured request already
 * carries removed: everything up to and including `covers`, system messages
 * kept (pi requires the leading one). What is left is the fork's own tail: the
 * reply that answered the capture, the fork's task, and its own turns. A
 * session fork copies the entries with their timestamps, so the boundary is
 * found by role and timestamp; undefined when it is not there (the fork
 * compacted, or the capture belongs to another branch).
 */
export function uncoveredMessages<M extends { role: string; timestamp?: number }>(messages: readonly M[], covers: CoveredThrough): M[] | undefined {
	const boundary = messages.findLastIndex((message) => message.role === covers.role && message.timestamp === covers.timestamp);
	if (boundary === -1) return undefined;
	return [...messages.slice(0, boundary + 1).filter((message) => message.role === "system"), ...messages.slice(boundary + 1)];
}

/** Anthropic's limit on `cache_control` breakpoints in one request. */
export const MAX_CACHE_MARKERS = 4;

/**
 * A fork's request: the parent's captured body byte for byte (system prompt,
 * tools, messages, `prompt_cache_key`, every other field), then the fork's own
 * tail from `child` (pi's body for the fork's uncovered messages), so the fork
 * reads the prefix the parent cached (decisions/caching.md, "A call that
 * inherits the session's context reads the session's cache").
 *
 * - Tools stay the parent's. A tool the fork gained after its first request
 *   (not in `baseline`, the first request's names), or one a tail
 *   `tool_reference` names, is appended so it stays callable; that breaks the
 *   cache from there on, as the same load does in the parent.
 * - The output cap is the smaller of the fork's and the parent's cap less the
 *   tail, since pi clamped the fork's to a context without the prefix.
 * - Cache markers: the parent's stay where the parent wrote its entry, the
 *   tail's mark the fork's own entry, and the earliest are dropped past four.
 */
export function forkRequestPayload(capture: RequestCapture, child: Record<string, unknown>, baseline: ReadonlySet<string>): Record<string, unknown> {
	const key = LIST_KEY[capture.api];
	const base = capture.payload[key] as unknown[];
	const tail = (Array.isArray(child[key]) ? (child[key] as WireMessage[]) : []).filter((entry) => entry.role !== "system" && entry.role !== "developer");
	const out: Record<string, unknown> = { ...capture.payload, [key]: capture.api === "anthropic-messages" ? joinUserTurns(base, tail) : [...base, ...tail] };
	const tools = forkTools(capture.payload.tools, child.tools, baseline, tail);
	if (tools) out.tools = tools;
	const capKey = MAX_TOKEN_KEYS[capture.api].find((k) => typeof capture.payload[k] === "number");
	if (capKey) {
		const room = (capture.payload[capKey] as number) - Math.ceil(JSON.stringify(tail).length / 4);
		const own = typeof child[capKey] === "number" ? (child[capKey] as number) : room;
		out[capKey] = Math.max(MIN_REPLAY_OUTPUT_TOKENS, Math.min(own, room));
	}
	capCacheMarkers(out, key);
	return out;
}

/** The names a body's tool list declares (Anthropic, Chat Completions and Responses shapes). */
export function toolNames(tools: unknown): string[] {
	return Array.isArray(tools) ? tools.map(toolName).filter((name): name is string => name !== undefined) : [];
}

function toolName(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (typeof tool.name === "string") return tool.name;
	return isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
}

function forkTools(parent: unknown, child: unknown, baseline: ReadonlySet<string>, tail: unknown[]): unknown[] | undefined {
	if (!Array.isArray(parent)) return Array.isArray(child) ? (withoutCacheControl(child) as unknown[]) : undefined;
	const declared = new Set(toolNames(parent));
	const referenced = referencedTools(tail);
	const extra = (Array.isArray(child) ? child : []).filter((tool) => {
		const name = toolName(tool);
		return name !== undefined && !declared.has(name) && (!baseline.has(name) || referenced.has(name));
	});
	return extra.length > 0 ? [...parent, ...(withoutCacheControl(extra) as unknown[])] : parent;
}

/** Tool names the tail's `tool_reference` blocks load (Anthropic tool search). */
function referencedTools(value: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(value)) for (const entry of value) referencedTools(entry, found);
	else if (isRecord(value)) {
		if (value.type === "tool_reference" && typeof value.tool_name === "string") found.add(value.tool_name);
		for (const entry of Object.values(value)) referencedTools(entry, found);
	}
	return found;
}

/** Anthropic needs alternating roles: a tail that opens with a user turn joins the captured last one. */
function joinUserTurns(base: unknown[], tail: unknown[]): unknown[] {
	const last = base.at(-1) as WireMessage | undefined;
	const first = tail[0] as WireMessage | undefined;
	if (last?.role === "user" && first?.role === "user") {
		return [...base.slice(0, -1), { ...last, content: [...blocksOf(last.content), ...blocksOf(first.content)] }, ...tail.slice(1)];
	}
	return [...base, ...tail];
}

/**
 * Drop the earliest `cache_control` markers (tools, then system, then
 * messages) past the limit. Copy-on-write: the captured body is shared by
 * every fork, so only the path to a dropped marker is copied.
 */
function capCacheMarkers(payload: Record<string, unknown>, listKey: string): void {
	const keys = ["tools", "system", listKey].filter((key) => key in payload);
	const total = keys.reduce((sum, key) => sum + countMarkers(payload[key]), 0);
	const budget = { drop: total - MAX_CACHE_MARKERS };
	for (const key of keys) {
		if (budget.drop <= 0) break;
		payload[key] = dropFirstMarkers(payload[key], budget);
	}
}

function countMarkers(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((sum: number, entry) => sum + countMarkers(entry), 0);
	if (!isRecord(value)) return 0;
	let count = "cache_control" in value ? 1 : 0;
	for (const [key, entry] of Object.entries(value)) if (key !== "cache_control") count += countMarkers(entry);
	return count;
}

function dropFirstMarkers(value: unknown, budget: { drop: number }): unknown {
	if (budget.drop <= 0) return value;
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map((entry) => {
			const next = dropFirstMarkers(entry, budget);
			if (next !== entry) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (!isRecord(value)) return value;
	let out: Record<string, unknown> | undefined;
	if ("cache_control" in value) {
		const { cache_control: _, ...rest } = value;
		out = rest;
		budget.drop--;
	}
	for (const [key, entry] of Object.entries(out ?? value)) {
		if (budget.drop <= 0) break;
		const next = dropFirstMarkers(entry, budget);
		if (next !== entry) out = { ...(out ?? value), [key]: next };
	}
	return out ?? value;
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

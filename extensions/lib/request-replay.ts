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
import { settleSystemMessages } from "./ledger/layout.ts";
import { isObject } from "./ledger/records.ts";
import { appendPoint, isToolsItem, listKey, preludeLength, responsesDeclarations, stripMarkers, toolName } from "./ledger/wire.ts";
import { estimateMessageTokens } from "./pi-ai-estimate.ts";

/** The compaction extension publishes a RequestCapture here, or undefined when none is valid. */
export const LAST_REQUEST_CHANNEL = "one-code:last-request";

/** The provider APIs whose request body can be extended by appending to one list. */
export type ReplayApi =
	| "anthropic-messages"
	| "openai-completions"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex";

/**
 * Where the output cap lives, first match in the captured body wins: a
 * top-level field, or one level down (Bedrock's `inferenceConfig.maxTokens`,
 * Google's `config.maxOutputTokens`). Codex sends none.
 */
const CAP_PATHS: Record<ReplayApi, ReadonlyArray<readonly string[]>> = {
	"anthropic-messages": [["max_tokens"]],
	"openai-completions": [["max_completion_tokens"], ["max_tokens"]],
	"openai-responses": [["max_output_tokens"]],
	"azure-openai-responses": [["max_output_tokens"]],
	"openai-codex-responses": [],
	"bedrock-converse-stream": [["inferenceConfig", "maxTokens"]],
	"google-generative-ai": [["config", "maxOutputTokens"]],
	"google-vertex": [["config", "maxOutputTokens"]],
};

const REPLAY_APIS: ReadonlySet<string> = new Set<ReplayApi>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
]);

/** The value at `path` in `payload`, when it is a number. */
function capAt(payload: Record<string, unknown>, path: readonly string[]): number | undefined {
	let value: unknown = payload;
	for (const key of path) value = isObject(value) ? value[key] : undefined;
	return typeof value === "number" ? value : undefined;
}

/** The path of the cap `payload` carries for `api`, or the first one the API takes. */
function capPath(api: ReplayApi, payload: Record<string, unknown>): readonly string[] | undefined {
	const paths = CAP_PATHS[api];
	return paths.find((path) => capAt(payload, path) !== undefined) ?? paths[0];
}

/** `payload` with `value` at `path`, copying only the objects on the way. */
function withCap(payload: Record<string, unknown>, path: readonly string[], value: number): Record<string, unknown> {
	const [head, ...rest] = path;
	if (rest.length === 0) return { ...payload, [head]: value };
	const inner = isObject(payload[head]) ? (payload[head] as Record<string, unknown>) : {};
	return { ...payload, [head]: withCap(inner, rest, value) };
}

/** The session's last provider request body, and the model it went to. */
export interface RequestCapture {
	api: ReplayApi;
	provider: string;
	modelId: string;
	payload: Record<string, unknown>;
	/** The last message of the context the body was built from: where a fork's own messages start. */
	covers?: CoveredThrough;
	/** The session the body went out for: its id is the routing affinity a fork must send too. */
	sessionId?: string;
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
export function captureRequest(model: ModelRef | undefined, payload: unknown, covers?: CoveredThrough, sessionId?: string): RequestCapture | undefined {
	const api = model?.api;
	if (!api || !REPLAY_APIS.has(api)) return undefined;
	if (!model?.provider || !model.id || !isObject(payload) || !Array.isArray(payload[listKey(api)])) return undefined;
	return { api: api as ReplayApi, provider: model.provider, modelId: model.id, payload, ...(covers ? { covers } : {}), ...(sessionId ? { sessionId } : {}) };
}

/** The model fields pi-ai reads to choose its session-affinity headers. */
export interface AffinityModel extends ModelRef {
	baseUrl?: string;
	compat?: { sendSessionAffinityHeaders?: boolean; sessionAffinityFormat?: string };
}

/**
 * The session-affinity headers pi-ai sends with `sessionId` for `model`, so a
 * fork can send its parent's: a gateway routes on them (OpenRouter spreads a
 * model across hosts, each with its own cache), and the fork is a different
 * session. Extension headers merge after pi-ai's, so these override. A copy
 * of pi-ai's `createClient` rules for the three replayable APIs, unchanged
 * from 0.87.1 to 0.99.2 (re-check at a pi bump:
 * features/pi-adaptation/plan.md §3 step 9).
 */
export function affinityHeaders(model: AffinityModel | undefined, sessionId: string): Record<string, string> {
	if (!model) return {};
	const openRouter = model.provider === "openrouter" || (model.baseUrl ?? "").includes("openrouter.ai");
	const send = model.compat?.sendSessionAffinityHeaders ?? openRouter;
	if (model.api === "anthropic-messages") {
		if (!send) return {};
		const format = model.compat?.sessionAffinityFormat ?? (openRouter ? "openrouter" : undefined);
		return { [format === "openrouter" ? "x-session-id" : "x-session-affinity"]: sessionId };
	}
	if (model.api !== "openai-completions" && model.api !== "openai-responses") return {};
	if (model.api === "openai-completions" && !send) return {};
	const format = model.compat?.sessionAffinityFormat ?? (openRouter ? "openrouter" : "openai");
	if (format === "openrouter") return { "x-session-id": sessionId };
	return {
		...(format === "openai" ? { session_id: sessionId } : {}),
		"x-client-request-id": sessionId,
		...(model.api === "openai-completions" ? { "x-session-affinity": sessionId } : {}),
	};
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
	const key = listKey(capture.api);
	const base = capture.payload[key] as unknown[];
	// The tail's own markers are dropped: the capture's mark the entry the session wrote.
	const extra = stripMarkers(Array.isArray(tail[key]) ? (tail[key] as unknown[]) : []);
	const list =
		capture.api === "anthropic-messages"
			? settleSystemMessages(appendAnthropic(base, extra), capture.api, base.length)
			: capture.api === "bedrock-converse-stream" || capture.api.startsWith("google-")
				? joinTurns(base, extra, capture.api.startsWith("google-") ? "parts" : "content")
				: [...base, ...extra];
	let out: Record<string, unknown> = { ...capture.payload, [key]: list };
	// Google's config carries the request's live abort signal: the side call's own, never the session's.
	if (capture.api.startsWith("google-") && isObject(out.config)) {
		const { abortSignal: _session, ...config } = out.config;
		const own = isObject(tail.config) ? tail.config.abortSignal : undefined;
		out = { ...out, config: own === undefined ? config : { ...config, abortSignal: own } };
	}
	const path = maxTokens === undefined ? undefined : capPath(capture.api, capture.payload);
	return path && maxTokens !== undefined ? withCap(out, path, maxTokens) : out;
}

/**
 * The tail appended so turns still alternate: a tail that opens with a user
 * turn joins a captured trailing user turn (Bedrock and Google reject two in
 * a row). `field` is where a turn keeps its blocks (`parts` on Google).
 */
function joinTurns(base: unknown[], tail: unknown[], field: "content" | "parts"): unknown[] {
	const last = base.at(-1) as Record<string, unknown> | undefined;
	const first = tail[0] as Record<string, unknown> | undefined;
	if (last?.role === "user" && first?.role === "user" && Array.isArray(last[field]) && Array.isArray(first[field])) {
		return [...base.slice(0, -1), { ...last, [field]: [...(last[field] as unknown[]), ...(first[field] as unknown[])] }, ...tail.slice(1)];
	}
	return [...base, ...tail];
}

/** The output cap the captured body carries, if any. */
function capturedMaxTokens(capture: RequestCapture): number | undefined {
	for (const path of CAP_PATHS[capture.api]) {
		const value = capAt(capture.payload, path);
		if (value !== undefined) return value;
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
	const key = listKey(capture.api);
	const base = capture.payload[key] as unknown[];
	const childList = Array.isArray(child[key]) ? (child[key] as WireMessage[]) : [];
	const responses = capture.api.endsWith("-responses");
	// What the capture declares, wherever it keeps its tools (pi 1.4.0 keeps a
	// Responses request's in a leading `additional_tools` item, findings §78).
	const parentDeclared = new Set(responses ? responsesDeclarations(capture.payload, capture.api).keys() : toolNames(capture.payload.tools));
	// The child's own system messages and prelude go; a Responses load item its
	// tool_search placed in the tail stays, less what the capture declares.
	const tail = childList.slice(responses ? preludeLength(childList, capture.api) : 0).flatMap((entry): WireMessage[] => {
		if (responses && isToolsItem(entry)) {
			const tools = entry.tools.filter((tool) => !parentDeclared.has(toolName(tool) ?? ""));
			return tools.length > 0 ? [{ ...entry, tools } as WireMessage] : [];
		}
		return entry.role !== "system" && entry.role !== "developer" ? [entry] : [];
	});
	const childHead = responses && isToolsItem(childList[0]) ? childList[0].tools : [];
	const childTools = [...(Array.isArray(child.tools) ? child.tools : []), ...childHead];
	const inTail = responses ? new Set(responsesDeclarations({ [key]: tail }, capture.api).keys()) : new Set<string>();
	const gained = forkGainedTools(parentDeclared, childTools.filter((tool) => !inTail.has(toolName(tool) ?? "")), baseline, tail);
	// A gained tool goes where the capture keeps its tools: appended to its
	// top-level array, else in an item at the start of the fork's tail (after
	// the parent's prefix, which it then keeps).
	const topLevel = Array.isArray(capture.payload.tools) || !responses;
	const ownTail = gained.length > 0 && !topLevel ? [{ type: "additional_tools", role: "developer", tools: gained } as WireMessage, ...tail] : tail;
	const out: Record<string, unknown> = { ...capture.payload, [key]: capture.api === "anthropic-messages" ? settleSystemMessages(appendTurns(base, ownTail), capture.api, base.length) : [...base, ...ownTail] };
	if (topLevel) {
		const tools = forkTools(capture.payload.tools, child.tools, gained);
		if (tools) out.tools = tools;
	}
	const capKey = CAP_PATHS[capture.api].find((path) => capAt(capture.payload, path) !== undefined);
	// Appended tool schemas spend room too; the parent's own tools are already in its cap.
	const tailRoom = forkOutputRoom(capture, ownTail);
	const room = tailRoom === undefined ? undefined : tailRoom - (topLevel && gained.length > 0 ? Math.ceil(JSON.stringify(gained).length / 4) : 0);
	let result = out;
	if (capKey && room !== undefined) {
		// Never above the room: the fork chose the fallback before this when too little was left.
		const own = capAt(child, capKey) ?? room;
		result = withCap(out, capKey, Math.max(1, Math.min(own, room)));
	}
	capCacheMarkers(result, key, capture, ownTail);
	return result;
}

/** The tool names a fork's first request declares, wherever it keeps them: the baseline its later gains are measured from. */
export function forkBaselineNames(payload: Record<string, unknown>, api: string): Set<string> {
	return new Set(api.endsWith("-responses") ? responsesDeclarations(payload, api).keys() : toolNames(payload.tools));
}

/**
 * The output room a fork request leaves: the captured cap (pi clamped it to
 * what the parent's context left of the window) less a rough size of `tail`.
 * Undefined when the capture names no cap. A fork whose room is below
 * `MIN_REPLAY_OUTPUT_TOKENS` must not be spliced: it goes out whole instead.
 */
export function forkOutputRoom(capture: RequestCapture, tail: unknown): number | undefined {
	const cap = capturedMaxTokens(capture);
	return cap === undefined ? undefined : cap - Math.ceil(JSON.stringify(tail).length / 4);
}

/** The names a body's tool list declares, in any API's shape (lib/ledger/wire.ts toolName). */
export function toolNames(tools: unknown): string[] {
	return Array.isArray(tools) ? tools.map(toolName).filter((name): name is string => name !== undefined) : [];
}

/**
 * The child's tools the capture does not declare and the fork needs: one it
 * gained after its first request (not in `baseline`), or one a tail
 * `tool_reference` names. Markers stripped: the capture's own mark stays.
 */
function forkGainedTools(declared: ReadonlySet<string>, child: readonly unknown[], baseline: ReadonlySet<string>, tail: unknown[]): unknown[] {
	const referenced = referencedTools(tail);
	return stripMarkers(
		child.filter((tool) => {
			const name = toolName(tool);
			return name !== undefined && !declared.has(name) && (!baseline.has(name) || referenced.has(name));
		}),
	);
}

/** The fork's top-level tools: the capture's, then the gained ones; the child's own when the capture has none. */
function forkTools(parent: unknown, child: unknown, gained: readonly unknown[]): unknown[] | undefined {
	if (!Array.isArray(parent)) return Array.isArray(child) ? stripMarkers(child) : undefined;
	return gained.length > 0 ? [...parent, ...gained] : parent;
}

/** Tool names the tail's `tool_reference` blocks load (Anthropic tool search). */
function referencedTools(value: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(value)) for (const entry of value) referencedTools(entry, found);
	else if (isObject(value)) {
		if (value.type === "tool_reference" && typeof value.tool_name === "string") found.add(value.tool_name);
		for (const entry of Object.values(value)) referencedTools(entry, found);
	}
	return found;
}

/**
 * `tail` after a captured Anthropic list, with the capture kept a byte
 * prefix. A tail that opens with a user turn joins the captured last one, so
 * the roles alternate. A capture that ends in a content system run (a
 * `<total_tokens>` countdown, a context message) took no clean reply: a user
 * turn after it would strand the run, and the layout pass would move the run
 * behind it, rewriting what the session cached there (findings §73). A text
 * turn goes in as a system message instead, so the run stays where its cache
 * entry was written. A side prompt opens its tail that way, and so does a fork
 * taken before the capture's reply landed (a `/btw` fork while it streams).
 */
function appendTurns(base: unknown[], tail: unknown[]): unknown[] {
	const last = base.at(-1) as WireMessage | undefined;
	const first = tail[0] as WireMessage | undefined;
	if (last?.role === "user" && first?.role === "user") {
		return [...base.slice(0, -1), { ...last, content: [...blocksOf(last.content), ...blocksOf(first.content)] }, ...tail.slice(1)];
	}
	if (first?.role === "user" && endsInSystemRun(base) && blocksOf(first.content).every((block) => block.type === "text")) {
		return [...base, { role: "system", content: blocksOf(first.content) }, ...tail.slice(1)];
	}
	return [...base, ...tail];
}

/**
 * Drop the earliest `cache_control` markers (tools, then system, then
 * messages) past the limit. Copy-on-write: the captured body is shared by
 * every fork, so only the path to a dropped marker is copied.
 */
function capCacheMarkers(payload: Record<string, unknown>, listKey: string, base: RequestCapture, tail: unknown[]): void {
	const keys = ["tools", "system", listKey].filter((key) => key in payload);
	// Appended tools carry no markers, so the body holds the capture's and the tail's.
	const total = captureMarkers(base) + countMarkers(tail);
	const budget = { drop: total - MAX_CACHE_MARKERS };
	for (const key of keys) {
		if (budget.drop <= 0) break;
		payload[key] = dropFirstMarkers(payload[key], budget);
	}
}

/** The captured body's marker count, walked once per capture: the list can hold a 1M-token transcript. */
const capturedMarkerCounts = new WeakMap<RequestCapture, number>();
function captureMarkers(capture: RequestCapture): number {
	let count = capturedMarkerCounts.get(capture);
	if (count === undefined) {
		const payload = capture.payload;
		count = countMarkers(payload.tools) + countMarkers(payload.system) + countMarkers(payload[listKey(capture.api)]);
		capturedMarkerCounts.set(capture, count);
	}
	return count;
}

function countMarkers(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((sum: number, entry) => sum + countMarkers(entry), 0);
	if (!isObject(value)) return 0;
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
	if (!isObject(value)) return value;
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
	return appendTurns(base, extra);
}

/** Whether the list, past its trailing directives, ends in a system message with content. */
function endsInSystemRun(list: unknown[]): boolean {
	const last = list[appendPoint(list, "anthropic-messages") - 1] as WireMessage | undefined;
	return last?.role === "system" && blocksOf(last.content).length > 0;
}

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

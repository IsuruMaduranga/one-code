/**
 * Requests on the wire as ledger deltas (design.md section 4.1). A request is
 * split into its list (Anthropic and Chat Completions `messages`, Responses
 * `input`, Google `contents`) and its head (everything else that is part of
 * the prefix). Elements are stored once, content-addressed, with cache
 * markers stripped: their placement moves every request and is the cache
 * marker owner's job, not content.
 *
 * Pure: no pi imports.
 */
import { createHash } from "node:crypto";
import { isObject, type RequestIdentity, type RequestRecordData, sameIdentity } from "./records.ts";

/** A provider request body as pi-ai built it. */
export type WirePayload = Record<string, unknown>;

/** A recorded request rebuilt from the branch: the list and head as sent, markers stripped. */
export interface RecordedRequest {
	identity: RequestIdentity;
	list: unknown[];
	head: Record<string, unknown>;
	/** Hashes of `list`, element by element. */
	hashes: string[];
	headHash: string;
}

/** The body key that holds the list for this API. */
export function listKey(api: string): "messages" | "input" | "contents" {
	if (api.endsWith("-responses")) return "input";
	if (api.startsWith("google-")) return "contents";
	return "messages";
}

/** A Bedrock Converse `{ cachePoint }` block: a marker that is a whole list element. */
const isCachePoint = (value: unknown): boolean => isObject(value) && Object.keys(value).length === 1 && "cachePoint" in value;

/**
 * Fields that hold the model's or a tool author's data, never a cache marker:
 * a tool call's input (`input`, Google's `args`, Bedrock's `toolUse.input`, a
 * Responses call's `arguments`) and a tool's schema. A `cache_control` key
 * inside one is content.
 */
const DATA_FIELDS: ReadonlySet<string> = new Set(["input", "args", "arguments", "input_schema", "inputSchema", "parameters"]);

/** `value` without cache markers (`cache_control`, Bedrock `cachePoint` blocks), deeply, except inside `DATA_FIELDS`. */
export function stripMarkers<T>(value: T): T {
	if (Array.isArray(value)) return value.filter((item) => !isCachePoint(item)).map(stripMarkers) as T;
	if (!isObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) if (key !== "cache_control") out[key] = DATA_FIELDS.has(key) ? item : stripMarkers(item);
	return out as T;
}

/** JSON with sorted keys and without cache markers, so neither key order nor a marker changes a hash; `undefined` fields drop out as in JSON. */
function canonical(value: unknown, data = false): string {
	if (Array.isArray(value)) return `[${value.filter((item) => data || !isCachePoint(item)).map((item) => (item === undefined ? "null" : canonical(item, data))).join(",")}]`;
	if (!isObject(value)) return JSON.stringify(value) ?? "null";
	const fields = Object.keys(value)
		.filter((key) => (data || key !== "cache_control") && value[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key], data || DATA_FIELDS.has(key))}`);
	return `{${fields.join(",")}}`;
}

/** A stable content hash of `value`: object key order does not matter, cache markers are ignored. */
export function contentHash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Top-level output caps: a cache warm sends the same body with the cap at 1. */
const CAP_KEYS: ReadonlySet<string> = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens", "maxTokens"]);

/** Fields nested one level down that are not content: Google's cap and abort signal, Bedrock's cap. */
const NESTED_OMIT: Record<string, readonly string[]> = {
	config: ["maxOutputTokens", "abortSignal"],
	inferenceConfig: ["maxTokens"],
};

/** The largest output cap pi's cache warmer sends: `maxTokens: 1`, which an API with a floor raises (Responses takes 16). */
const WARM_CAP = 16;

/** The payload's output caps, top-level and nested, wherever the API puts them. */
function outputCaps(payload: WirePayload): number[] {
	const caps: number[] = [];
	for (const [key, value] of Object.entries(payload)) {
		if (CAP_KEYS.has(key) && typeof value === "number") caps.push(value);
		const nested = NESTED_OMIT[key];
		if (nested && isObject(value)) for (const field of nested) if (typeof value[field] === "number") caps.push(value[field] as number);
	}
	return caps;
}

/** Whether `payload` carries pi's cache-warm output cap (a real session request asks for more, except an over-window one, which comes with a fresh plan). */
export function hasWarmCap(payload: WirePayload): boolean {
	const caps = outputCaps(payload);
	return caps.length > 0 && caps.every((cap) => cap <= WARM_CAP);
}

/** `body` with the request-only fields of `from` (its output caps, Google's abort signal) in place of its own. */
export function withRequestFields(body: WirePayload, from: WirePayload): WirePayload {
	const out: WirePayload = { ...body };
	for (const key of CAP_KEYS) {
		if (key in from) out[key] = from[key];
		else delete out[key];
	}
	for (const [key, fields] of Object.entries(NESTED_OMIT)) {
		const source = from[key];
		const target = out[key];
		if (!isObject(source) || !isObject(target)) continue;
		const merged: Record<string, unknown> = { ...target };
		for (const field of fields) {
			if (field in source) merged[field] = source[field];
			else delete merged[field];
		}
		out[key] = merged;
	}
	return out;
}

/** The head of a payload: every body field outside the list and the output cap, markers stripped. */
export function payloadHead(payload: WirePayload, api: string): Record<string, unknown> {
	const list = listKey(api);
	const head: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (key === list || CAP_KEYS.has(key)) continue;
		const omit = NESTED_OMIT[key];
		head[key] = omit && isObject(value) ? Object.fromEntries(Object.entries(value).filter(([field]) => !omit.includes(field))) : value;
	}
	return stripMarkers(head);
}

/** The payload's list, or an empty one when the body has none under this API's key. */
function payloadList(payload: WirePayload, api: string): unknown[] {
	const list = payload[listKey(api)];
	return Array.isArray(list) ? list : [];
}

/**
 * `payload` as the ledger records it: its list and head, markers stripped,
 * and their hashes. `prefix`: the payload's list starts with `base`'s first
 * `end` elements (a splice's), so only the rest is stripped and hashed.
 */
export function recordedRequest(payload: WirePayload, identity: RequestIdentity, prefix?: { base: RecordedRequest; end: number }): RecordedRequest {
	const end = prefix?.end ?? 0;
	const tail = stripMarkers(payloadList(payload, identity.api).slice(end));
	const head = payloadHead(payload, identity.api);
	const list = prefix ? prefix.base.list.slice(0, end).concat(tail) : tail;
	const hashes = (prefix ? prefix.base.hashes.slice(0, end) : []).concat(tail.map(contentHash));
	return { identity, list, head, hashes, headHash: contentHash(head) };
}

/**
 * The record for `current`, or undefined when it adds nothing: the same list
 * and head as `previous` (a pi cache warm or a provider retry re-running the
 * hooks). `known` holds every hash already on the branch, so `blobs` carries
 * only new bodies.
 */
export function encodeRequest(
	previous: RecordedRequest | undefined,
	current: RecordedRequest,
	known: { has(hash: string): boolean },
): Omit<RequestRecordData, "v" | "by" | "consumed"> | undefined {
	const { identity, list, head, hashes, headHash } = current;
	let keep = 0;
	if (previous) while (keep < hashes.length && keep < previous.hashes.length && hashes[keep] === previous.hashes[keep]) keep++;
	const unchanged = previous && keep === hashes.length && keep === previous.hashes.length && headHash === previous.headHash && sameIdentity(identity, previous.identity);
	if (unchanged) return undefined;

	const blobs: Record<string, unknown> = {};
	for (let i = keep; i < list.length; i++) if (!known.has(hashes[i])) blobs[hashes[i]] = list[i];
	if (!known.has(headHash)) blobs[headHash] = head;
	return { identity, keep, append: hashes.slice(keep), head: headHash, blobs };
}

/** APIs whose list starts with the system prompt as an instruction message (Chat Completions, Responses but not Codex, Mistral). */
const PROMPT_IN_LIST: ReadonlySet<string> = new Set(["openai-completions", "openai-responses", "azure-openai-responses", "mistral-conversations"]);

/**
 * How many leading elements of pi's list render the system prompt: one where
 * the API puts the prompt in the list, else none. A request that sends only
 * its tail through pi still gets that element, which the record already holds.
 */
export function preludeLength(list: readonly unknown[], api: string): number {
	if (!PROMPT_IN_LIST.has(api)) return 0;
	const role = isObject(list[0]) ? list[0].role : undefined;
	return role === "system" || role === "developer" ? 1 : 0;
}

/**
 * An element pi-ai appends to the end of every request and the next request
 * replaces: Anthropic's directive-only effort message, the Responses
 * `configuration_update` item. The next request's own copy comes before the
 * reply it answers, so a recorded list ending in one drops it before the tail
 * is appended.
 */
export function isTrailer(element: unknown, api: string): boolean {
	if (!isObject(element)) return false;
	if (api === "anthropic-messages") return element.role === "system" && Array.isArray(element.content) && element.content.length === 0 && element.output_config !== undefined;
	if (api.endsWith("-responses")) return element.type === "configuration_update";
	return false;
}

/** A tool's name in any API's declaration shape, or undefined for a nameless entry (a Bedrock `cachePoint`). */
export function toolName(tool: unknown): string | undefined {
	if (!isObject(tool)) return undefined;
	if (typeof tool.name === "string") return tool.name;
	if (isObject(tool.function) && typeof tool.function.name === "string") return tool.function.name;
	if (isObject(tool.toolSpec) && typeof tool.toolSpec.name === "string") return tool.toolSpec.name;
	return typeof tool.type === "string" && !("cachePoint" in tool) ? `type:${tool.type}` : undefined;
}

/** Google's function declarations, flattened out of its tool groups. */
export function functionDeclarations(groups: readonly unknown[]): unknown[] {
	return groups.flatMap((group) => (isObject(group) && Array.isArray(group.functionDeclarations) ? group.functionDeclarations : []));
}

/** Every declaration in a payload or head: `tools`, Bedrock `toolConfig.tools`, Google's function declarations. */
export function declarationsOf(payload: WirePayload): unknown[] {
	const config = isObject(payload.config) ? payload.config : undefined;
	const toolConfig = isObject(payload.toolConfig) ? payload.toolConfig : undefined;
	const google = Array.isArray(config?.tools) ? functionDeclarations(config.tools) : [];
	return [...(Array.isArray(payload.tools) ? payload.tools : []), ...(Array.isArray(toolConfig?.tools) ? toolConfig.tools : []), ...google];
}

/** The names a payload or head declares, in any API's shape; `eager` keeps only declarations not marked `defer_loading`. */
export function declaredToolNames(payload: WirePayload, { eager = false } = {}): Set<string> {
	const names = new Set<string>();
	for (const tool of declarationsOf(payload)) {
		const name = eager && isObject(tool) && tool.defer_loading === true ? undefined : toolName(tool);
		if (name !== undefined) names.add(name);
	}
	return names;
}

/** A declaration's input schema, in any API's shape: what pi validates a call's arguments against. */
function inputSchemaOf(tool: unknown): unknown {
	if (!isObject(tool)) return undefined;
	if (isObject(tool.function)) return tool.function.parameters;
	if (isObject(tool.toolSpec)) return tool.toolSpec.inputSchema;
	return tool.input_schema ?? tool.parameters ?? tool.parametersJsonSchema;
}

/** The live declaration with the recorded one's `defer_loading`: a load or a deferral moves that flag, never the tool. */
function withRecordedDeferral(live: unknown, recorded: unknown): unknown {
	if (!isObject(live) || !isObject(recorded)) return live;
	const { defer_loading: _live, ...rest } = live;
	return recorded.defer_loading === undefined ? rest : { ...rest, defer_loading: recorded.defer_loading };
}

/**
 * The recorded declarations in their recorded order and bytes, then the live
 * ones the record lacks. A live declaration equal to its recorded one is kept
 * as pi built it (its cache marker included); one that differs only in its
 * text or its deferral takes the recorded bytes, so a description variant or a
 * load never moves the tools array. One whose input schema changed (an
 * upgrade, an MCP server's new schema) takes the live
 * declaration, with the recorded deferral: pi validates and runs a call
 * against the live schema, so the wire must offer that one. Nameless markers
 * that end the live list (Bedrock `cachePoint`) end it.
 */
export function mergeDeclarations(recorded: readonly unknown[], live: readonly unknown[], declaredElsewhere: ReadonlySet<string> = new Set()): unknown[] {
	const liveByName = new Map<string, unknown>();
	for (const tool of live) {
		const name = toolName(tool);
		if (name !== undefined && !liveByName.has(name)) liveByName.set(name, tool);
	}
	const out: unknown[] = [];
	const seen = new Set<string>();
	for (const tool of recorded) {
		const name = toolName(tool);
		if (name === undefined) continue;
		seen.add(name);
		const current = liveByName.get(name);
		if (current !== undefined && contentHash(current) === contentHash(tool)) out.push(current);
		else if (current !== undefined && contentHash(inputSchemaOf(current)) !== contentHash(inputSchemaOf(tool))) out.push(withRecordedDeferral(current, tool));
		else out.push(structuredClone(tool));
	}
	for (const tool of live) {
		const name = toolName(tool);
		if (name === undefined || seen.has(name) || declaredElsewhere.has(name)) continue;
		seen.add(name);
		out.push(tool);
	}
	let trailing = live.length;
	while (trailing > 0 && toolName(live[trailing - 1]) === undefined) trailing--;
	return [...withToolsMarker(out, live), ...live.slice(trailing)];
}

/**
 * The merged declarations with pi's tools cache marker on the last one that is
 * not deferred, where pi puts it: the merge can make another tool last, and
 * Anthropic rejects a marker on a `defer_loading` tool.
 */
function withToolsMarker(tools: unknown[], live: readonly unknown[]): unknown[] {
	const marked = live.find((tool) => isObject(tool) && tool.cache_control !== undefined);
	const mark = isObject(marked) ? marked.cache_control : undefined;
	const out = tools.map((tool) => {
		if (!isObject(tool) || tool.cache_control === undefined) return tool;
		const { cache_control: _mark, ...rest } = tool;
		return rest;
	});
	if (mark === undefined) return out;
	const at = out.findLastIndex((tool) => isObject(tool) && tool.defer_loading !== true);
	if (at !== -1) out[at] = { ...(out[at] as Record<string, unknown>), cache_control: mark };
	return out;
}

/**
 * `recorded` in place of `live` unless they match, then `live` (with pi's
 * cache markers). pi's breakpoint carries over: the live last block's
 * `cache_control`, or Bedrock's trailing `{ cachePoint }` blocks.
 */
function recordedValue(recorded: unknown, live: unknown): unknown {
	if (recorded === undefined) return live;
	if (live !== undefined && contentHash(recorded) === contentHash(live)) return live;
	const copy = structuredClone(recorded);
	if (!Array.isArray(copy) || !Array.isArray(live)) return copy;
	let content = live.length;
	while (content > 0 && isCachePoint(live[content - 1])) content--;
	const points = live.slice(content);
	const lastLive = live[content - 1];
	const mark = isObject(lastLive) ? lastLive.cache_control : undefined;
	const last = copy.at(-1);
	if (mark !== undefined && isObject(last)) last.cache_control = mark;
	return [...copy, ...points];
}

/**
 * The payload with the epoch's recorded system prompt, tools and cache key
 * (OpenAI's `prompt_cache_key`) in place of pi's rendering, keeping every other field as pi built it. Tools pi declares
 * that the record lacks are appended (a tool added mid-epoch); a recorded one
 * pi no longer declares stays (Claude Code never removes a tool mid-conversation).
 */
export function withRecordedHead(payload: WirePayload, head: Record<string, unknown>, api: string, declaredElsewhere: ReadonlySet<string> = new Set()): WirePayload {
	const out: WirePayload = { ...payload };
	const merge = (recordedTools: unknown, liveTools: unknown) =>
		Array.isArray(recordedTools) ? mergeDeclarations(recordedTools, Array.isArray(liveTools) ? liveTools : [], declaredElsewhere) : liveTools;
	if (api.startsWith("google-")) {
		const recorded = isObject(head.config) ? head.config : {};
		const live = isObject(payload.config) ? payload.config : {};
		const config: Record<string, unknown> = { ...live };
		if ("systemInstruction" in recorded) config.systemInstruction = recordedValue(recorded.systemInstruction, live.systemInstruction);
		const recordedGroups = Array.isArray(recorded.tools) ? recorded.tools : undefined;
		const liveGroups = Array.isArray(live.tools) ? live.tools : [];
		if (recordedGroups) {
			const merged = mergeDeclarations(functionDeclarations(recordedGroups), functionDeclarations(liveGroups));
			const others = recordedGroups.filter((group) => !(isObject(group) && Array.isArray(group.functionDeclarations)));
			config.tools = [...(merged.length ? [{ functionDeclarations: merged }] : []), ...others];
		}
		out.config = config;
		return out;
	}
	if (api === "bedrock-converse-stream") {
		if ("system" in head) out.system = recordedValue(head.system, payload.system);
		if (isObject(head.toolConfig)) {
			const live = isObject(payload.toolConfig) ? payload.toolConfig : {};
			out.toolConfig = { ...live, tools: merge(head.toolConfig.tools, live.tools) };
		}
		return out;
	}
	// The cache key routes to the host holding the record's cache: a fork child,
	// or a /fork, extends a request recorded under the parent session's key. Not
	// on Codex, where pi-ai also sends the session's own id as the `session-id`
	// header after every extension hook; a body key that disagrees with it read
	// nothing live (findings §75).
	const fields = api === "openai-codex-responses" ? ["system", "instructions"] : ["system", "instructions", "prompt_cache_key"];
	for (const field of fields) if (field in head) out[field] = recordedValue(head[field], payload[field]);
	if ("tools" in head) out.tools = merge(head.tools, payload.tools);
	// A beta an earlier request needed (a mid-conversation system message, a
	// tool_addition) is still needed: that request's messages are in this one.
	if (Array.isArray(head.betas)) {
		const live = Array.isArray(payload.betas) ? payload.betas : [];
		out.betas = [...head.betas, ...live.filter((beta) => !(head.betas as unknown[]).includes(beta))];
	}
	return out;
}

/** Whether `b`'s list starts with the same first `count` elements as `a`'s, element for element. */
export function samePrefix(a: WirePayload, b: WirePayload, key: string, count: number): boolean {
	if (a === b) return true;
	const left = a[key];
	const right = b[key];
	if (!Array.isArray(left) || !Array.isArray(right) || right.length < count) return false;
	for (let i = 0; i < count; i++) if (left[i] !== right[i]) return false;
	return true;
}

/** The append point of a recorded list: its length without the trailing directives the next request replaces (`isTrailer`). */
export function appendPoint(list: readonly unknown[], api: string): number {
	let end = list.length;
	while (end > 0 && isTrailer(list[end - 1], api)) end--;
	return end;
}

/**
 * The request that extends `base` inside its epoch: the base's list up to its
 * append point, then pi's rendering of only the messages after the base's
 * coverage (without the prompt element some APIs put first), under the
 * recorded head. Elements above the append point come from the record, so
 * nothing pi or an extension would render differently can change them.
 */
export function spliceRequest(base: RecordedRequest, payload: WirePayload, api: string): WirePayload {
	const list = payloadList(payload, api);
	const tail = list.slice(preludeLength(list, api));
	const prefix = structuredClone(base.list.slice(0, appendPoint(base.list, api)));
	return { ...withRecordedHead(payload, base.head, api, loadedInList(base.list)), [listKey(api)]: [...prefix, ...tail] };
}

/** The first `cache_control` marker on a list element or one of its content blocks. */
function listMarker(list: readonly unknown[]): unknown {
	for (const element of list) {
		if (!isObject(element)) continue;
		if (element.cache_control !== undefined) return element.cache_control;
		if (Array.isArray(element.content)) for (const block of element.content) if (isObject(block) && block.cache_control !== undefined) return block.cache_control;
	}
	return undefined;
}

/**
 * The recorded request `base` as a body to send again, under `payload`'s
 * request-only fields (a cache warm that outlived the instance that sent it:
 * pi's own rendering of its context is the cut tail). pi's conversation
 * marker goes back on the last block before the trailing directives, where pi
 * put it.
 */
export function recordedBody(base: RecordedRequest, payload: WirePayload, api: string): WirePayload {
	const list = structuredClone(base.list);
	const mark = listMarker(payloadList(payload, api));
	const last = list[appendPoint(list, api) - 1];
	if (mark !== undefined && isObject(last)) {
		const blocks = Array.isArray(last.content) ? last.content : undefined;
		const target = blocks?.at(-1);
		if (isObject(target)) target.cache_control = mark;
		else if (!blocks) last.cache_control = mark;
	}
	return withRequestFields({ ...withRecordedHead(payload, base.head, api, loadedInList(base.list)), [listKey(api)]: list }, payload);
}

/**
 * The tools a Responses list declares itself, at the point a tool_search
 * loaded them (an `additional_tools` item, a `tool_search_output`): pi renders
 * such a tool eager again once its load is in the recorded prefix, and the
 * head must not declare it twice.
 */
export function loadedInList(list: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const item of list) {
		if (!isObject(item) || (item.type !== "additional_tools" && item.type !== "tool_search_output") || !Array.isArray(item.tools)) continue;
		for (const tool of item.tools) {
			const name = toolName(tool);
			if (name !== undefined) names.add(name);
		}
	}
	return names;
}

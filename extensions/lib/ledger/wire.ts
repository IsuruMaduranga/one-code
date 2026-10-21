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

/** `value` without cache markers (`cache_control`, Bedrock `cachePoint` blocks), deeply. */
export function stripMarkers<T>(value: T): T {
	if (Array.isArray(value)) return value.filter((item) => !isCachePoint(item)).map(stripMarkers) as T;
	if (!isObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) if (key !== "cache_control") out[key] = stripMarkers(item);
	return out as T;
}

/** JSON with sorted keys and without cache markers, so neither key order nor a marker changes a hash; `undefined` fields drop out as in JSON. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.filter((item) => !isCachePoint(item)).map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
	if (!isObject(value)) return JSON.stringify(value) ?? "null";
	const fields = Object.keys(value)
		.filter((key) => key !== "cache_control" && value[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
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
 * and their hashes. `prefixHashes` are the known hashes of the list's first
 * elements (a splice's recorded prefix), so only the rest is hashed.
 */
export function recordedRequest(payload: WirePayload, identity: RequestIdentity, prefixHashes: readonly string[] = []): RecordedRequest {
	const list = stripMarkers(payloadList(payload, identity.api));
	const head = payloadHead(payload, identity.api);
	const hashes = [...prefixHashes, ...list.slice(prefixHashes.length).map(contentHash)];
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

/**
 * The recorded declarations in their recorded order and bytes, then the live
 * ones the record lacks. A live declaration equal to its recorded one is kept
 * as pi built it (its cache marker included); a changed one takes the recorded
 * bytes. Nameless markers that end the live list (Bedrock `cachePoint`) end it.
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
		out.push(current !== undefined && contentHash(current) === contentHash(tool) ? current : structuredClone(tool));
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

/** `recorded` in place of `live` unless they match, then `live` (with pi's cache markers); the live last block's marker carries over. */
function recordedValue(recorded: unknown, live: unknown): unknown {
	if (recorded === undefined) return live;
	if (live !== undefined && contentHash(recorded) === contentHash(live)) return live;
	const copy = structuredClone(recorded);
	if (Array.isArray(copy) && Array.isArray(live)) {
		const mark = isObject(live.at(-1)) ? (live.at(-1) as Record<string, unknown>).cache_control : undefined;
		const last = copy.at(-1);
		if (mark !== undefined && isObject(last)) last.cache_control = mark;
	}
	return copy;
}

/**
 * The payload with the epoch's recorded system prompt and tools in place of
 * pi's rendering, keeping every other field as pi built it. Tools pi declares
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
	for (const field of ["system", "instructions"]) if (field in head) out[field] = recordedValue(head[field], payload[field]);
	if ("tools" in head) out.tools = merge(head.tools, payload.tools);
	// A beta an earlier request needed (a mid-conversation system message, a
	// tool_addition) is still needed: that request's messages are in this one.
	if (Array.isArray(head.betas)) {
		const live = Array.isArray(payload.betas) ? payload.betas : [];
		out.betas = [...head.betas, ...live.filter((beta) => !(head.betas as unknown[]).includes(beta))];
	}
	return out;
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

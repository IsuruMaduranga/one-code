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

/** Whether `payload` carries pi's cache-warm output cap. A real request can too (pi-ai clamps its cap to the window's room), so the caller also checks it is a call of its own. */
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
 * Whether `element` is a Responses `additional_tools` item: tools declared in
 * the input. pi 1.4.0 and later declare a request's starting tools in one at
 * the head of the input for models flagged for mid-conversation system
 * messages and additional tools (findings §78); a `tool_search` load rides
 * one at its load point on any version.
 */
export function isToolsItem(element: unknown): element is Record<string, unknown> & { tools: unknown[] } {
	return isObject(element) && element.type === "additional_tools" && Array.isArray(element.tools);
}

/** A Responses `additional_tools` item declaring `tools`, in the shape of `like` (pi's own item) when there is one. */
export function toolsItemFor(tools: unknown[], like?: Record<string, unknown>): Record<string, unknown> {
	const { tools: _tools, ...shape } = like ?? { type: "additional_tools", role: "developer" };
	return { ...shape, tools };
}

/**
 * The `additional_tools` item a body declares its starting tools in (pi 1.4.0
 * and later, findings §78), given its top-level `tools` and its list; undefined
 * when it keeps them in a top-level array, or declares none at its head.
 */
export function leadingToolsItem(tools: unknown, list: readonly unknown[]): (Record<string, unknown> & { tools: unknown[] }) | undefined {
	const head = list[0];
	return !Array.isArray(tools) && isToolsItem(head) ? head : undefined;
}

/** A plain instruction message: role system or developer, not a typed item such as `additional_tools`. */
const isInstruction = (element: unknown): boolean => isObject(element) && (element.role === "system" || element.role === "developer") && (element.type === undefined || element.type === "message");

/**
 * How many leading elements of pi's list render its head: a Responses
 * request's leading `additional_tools` item (pi 1.4.0 and later), then the
 * system prompt where the API puts it in the list. A request that sends only
 * its tail through pi still gets them, and the record already holds them.
 * Read from the elements, never from pi's version: an element this does not
 * recognize stays in the tail, which costs tokens but never a declaration.
 */
export function preludeLength(list: readonly unknown[], api: string): number {
	let at = api.endsWith("-responses") && isToolsItem(list[0]) ? 1 : 0;
	if (PROMPT_IN_LIST.has(api) && isInstruction(list[at])) at++;
	return at;
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

/** The object whose `tools` array declares a body's tools: Google's `config` (its tools are groups of function declarations), Bedrock's `toolConfig`, else the body itself. */
type ToolsHolder = "config" | "toolConfig" | "body";

const toolsHolder = (api: string): ToolsHolder => (api.startsWith("google-") ? "config" : api === "bedrock-converse-stream" ? "toolConfig" : "body");

/** The `tools` array of `body`'s `holder`, or undefined when there is none. */
function toolsIn(body: WirePayload, holder: ToolsHolder): unknown[] | undefined {
	const at = holder === "body" ? body : body[holder];
	return isObject(at) && Array.isArray(at.tools) ? at.tools : undefined;
}

/** `body` with `tools` as its `holder`'s tools array, the holder created when absent. */
function withToolsIn(body: WirePayload, holder: ToolsHolder, tools: unknown[]): WirePayload {
	if (holder === "body") return { ...body, tools };
	const at = body[holder];
	return { ...body, [holder]: { ...(isObject(at) ? at : {}), tools } };
}

/** `body` with the tools array where `api` puts it mapped by `fn`: `body` itself when it has none or `fn` returns its input. */
function mapTools(body: WirePayload, api: string, fn: (tools: unknown[]) => unknown[]): WirePayload {
	const holder = toolsHolder(api);
	const tools = toolsIn(body, holder);
	const mapped = tools && fn(tools);
	return mapped === undefined || mapped === tools ? body : withToolsIn(body, holder, mapped);
}

/** Every declaration in a payload or head, whatever its API: `tools`, Bedrock `toolConfig.tools`, Google's function declarations. */
export function declarationsOf(payload: WirePayload): unknown[] {
	return [...(toolsIn(payload, "body") ?? []), ...(toolsIn(payload, "toolConfig") ?? []), ...functionDeclarations(toolsIn(payload, "config") ?? [])];
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
 * An epoch's live declarations in the order the branch first declared them
 * (`LedgerFold.toolOrder`), then the ones it never declared in pi's order;
 * nameless trailing markers stay last. pi derives its tools from the
 * transcript's tool deltas, where a changed definition is a removal and an
 * addition (pi-ai `getCurrentTools`), so a tool whose text follows the model
 * tier (bash, the description-form tools) moved to the end at every hop, and a
 * hop back to the earlier model missed the prefix it had cached. The bytes stay
 * pi's: only the order comes from the branch.
 */
export function orderLikeBranch<T extends readonly unknown[]>(order: readonly string[], live: T): T | unknown[] {
	const rank = new Map(order.map((name, index) => [name, index]));
	let trailing = live.length;
	while (trailing > 0 && toolName(live[trailing - 1]) === undefined) trailing--;
	const named = live.slice(0, trailing).filter((tool) => toolName(tool) !== undefined);
	const known = named.filter((tool) => rank.has(toolName(tool)!)).sort((a, b) => rank.get(toolName(a)!)! - rank.get(toolName(b)!)!);
	const ordered = [...known, ...named.filter((tool) => !rank.has(toolName(tool)!))];
	if (ordered.length === trailing && ordered.every((tool, index) => tool === live[index])) return live;
	return [...withToolsMarker(ordered, live), ...live.slice(trailing)];
}

/** `payload` with its declarations in the branch's order (`orderLikeBranch`), in any API's shape. */
export function withBranchToolOrder(payload: WirePayload, order: readonly string[], api: string): WirePayload {
	if (order.length === 0) return payload;
	const reorder = (tools: unknown[]) => orderLikeBranch(order, tools);
	const out = mapTools(payload, api, toolsHolder(api) === "config" ? (groups) => mapGroupDeclarations(groups, reorder) : reorder);
	// A Responses request that declares its starting tools in a leading item.
	const list = payloadList(out, api);
	const head = api.endsWith("-responses") ? leadingToolsItem(out.tools, list) : undefined;
	if (!head) return out;
	const tools = reorder(head.tools);
	return tools === head.tools ? out : { ...out, [listKey(api)]: [{ ...head, tools }, ...list.slice(1)] };
}

/** Google's tool groups with each group's function declarations mapped by `fn`: `groups` itself when `fn` returns every input. */
function mapGroupDeclarations(groups: unknown[], fn: (declarations: unknown[]) => unknown[]): unknown[] {
	const out = groups.map((group) => {
		if (!isObject(group) || !Array.isArray(group.functionDeclarations)) return group;
		const declarations = fn(group.functionDeclarations);
		return declarations === group.functionDeclarations ? group : { ...group, functionDeclarations: declarations };
	});
	return out.some((group, index) => group !== groups[index]) ? out : groups;
}

/** Google's recorded tool groups merged with the live ones: one group of the merged function declarations (none when empty), then the recorded groups without declarations. */
function mergeGroups(recorded: readonly unknown[], live: readonly unknown[]): unknown[] {
	const merged = mergeDeclarations(functionDeclarations(recorded), functionDeclarations(live));
	const others = recorded.filter((group) => !(isObject(group) && Array.isArray(group.functionDeclarations)));
	return [...(merged.length ? [{ functionDeclarations: merged }] : []), ...others];
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
	const holder = toolsHolder(api);
	const recordedTools = toolsIn(head, holder);
	const withMergedTools = (out: WirePayload): WirePayload => {
		if (!recordedTools) return out;
		const live = toolsIn(payload, holder) ?? [];
		return withToolsIn(out, holder, holder === "config" ? mergeGroups(recordedTools, live) : mergeDeclarations(recordedTools, live, declaredElsewhere));
	};
	if (holder === "config") {
		const recorded = isObject(head.config) ? head.config : {};
		const live = isObject(payload.config) ? payload.config : {};
		const config: Record<string, unknown> = { ...live };
		if ("systemInstruction" in recorded) config.systemInstruction = recordedValue(recorded.systemInstruction, live.systemInstruction);
		return withMergedTools({ ...payload, config });
	}
	let out: WirePayload = { ...payload };
	if (holder === "toolConfig") {
		if ("system" in head) out.system = recordedValue(head.system, payload.system);
		return withMergedTools(out);
	}
	// The cache key routes to the host holding the record's cache: a fork child,
	// or a /fork, extends a request recorded under the parent session's key. Not
	// on Codex, where pi-ai also sends the session's own id as the `session-id`
	// header after every extension hook; a body key that disagrees with it read
	// nothing live (findings §75).
	const fields = api === "openai-codex-responses" ? ["system", "instructions"] : ["system", "instructions", "prompt_cache_key"];
	for (const field of fields) if (field in head) out[field] = recordedValue(head[field], payload[field]);
	out = withMergedTools(out);
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
	const at = appendPoint(base.list, api);
	const out = underRecordedHead(base, payload, api, [...structuredClone(base.list.slice(0, at)), ...tail]);
	return api.endsWith("-responses") ? withLiveDeclarations(out, payload, api, base, at) : out;
}

/**
 * `list` under the record's head (`withRecordedHead`). A Responses record that
 * declares its starting tools in its list takes no top-level `tools` from pi:
 * an `additional_tools` item cannot replace a top-level tool, and a top-level
 * array ahead of the input would miss the cache. `withLiveDeclarations`
 * declares what the record lacks.
 */
function underRecordedHead(base: RecordedRequest, payload: WirePayload, api: string, list: unknown[]): WirePayload {
	const { tools: _live, ...withoutTools } = payload;
	const live = api.endsWith("-responses") && leadingToolsItem(base.head.tools, base.list) ? withoutTools : payload;
	return { ...withRecordedHead(live, base.head, api, loadedInList(base.list)), [listKey(api)]: list };
}

/** Every declaration a list's own items make (`additional_tools`, `tool_search_output`), by name in list order; a later one replaces an earlier one, as the API reads them. */
function listDeclarations(list: readonly unknown[]): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const item of list) {
		if (!isObject(item) || (item.type !== "additional_tools" && item.type !== "tool_search_output") || !Array.isArray(item.tools)) continue;
		for (const tool of item.tools) {
			const name = toolName(tool);
			if (name !== undefined) out.set(name, tool);
		}
	}
	return out;
}

/** Every declaration a Responses body makes, by name, wherever it sits: its top-level `tools`, then its list's items. */
export function responsesDeclarations(payload: WirePayload, api: string): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const tool of Array.isArray(payload.tools) ? payload.tools : []) {
		const name = toolName(tool);
		if (name !== undefined) out.set(name, tool);
	}
	for (const [name, tool] of listDeclarations(payloadList(payload, api))) out.set(name, tool);
	return out;
}

/**
 * `out` declaring every tool pi's own rendering (`live`) declares: a splice
 * keeps the record's head and drops pi's, so a tool pi added mid-epoch, or one
 * whose input schema changed, would otherwise go undeclared. It is declared
 * where the record keeps its tools: appended to the top-level `tools` (which
 * `withRecordedHead` already merged, so only a tool pi declared in an item
 * reaches here), or, for a record that declares in its list, in an
 * `additional_tools` item at the append point `at`, after the cached prefix.
 * A later item replaces an earlier item's declaration of the same name.
 */
function withLiveDeclarations(out: WirePayload, live: WirePayload, api: string, base: RecordedRequest, at: number): WirePayload {
	const recordItem = leadingToolsItem(base.head.tools, base.list);
	const liveItem = leadingToolsItem(live.tools, payloadList(live, api));
	// The usual request: pi's head item is the record's, and every other
	// declaration pi made rides the tail it sends.
	if (recordItem && liveItem && contentHash(liveItem) === base.hashes[0]) return out;
	const sent = responsesDeclarations(out, api);
	const needed = [...responsesDeclarations(live, api)].filter(([name, tool]) => {
		const current = sent.get(name);
		return current === undefined || (recordItem !== undefined && contentHash(inputSchemaOf(current)) !== contentHash(inputSchemaOf(tool)));
	});
	if (needed.length === 0) return out;
	const tools = needed.map(([, tool]) => stripMarkers(tool));
	if (!recordItem && Array.isArray(out.tools)) return { ...out, tools: [...out.tools, ...tools] };
	const list = payloadList(out, api);
	return { ...out, [listKey(api)]: [...list.slice(0, at), toolsItemFor(tools, liveItem ?? recordItem), ...list.slice(at)] };
}

/**
 * Every tool name a recorded request declares: its head's declarations, and
 * for a Responses record the ones in its list (a leading `additional_tools`
 * item, the items `tool_search` loads ride). `eager` drops head declarations
 * marked `defer_loading`; a list declaration is always eager.
 */
export function recordedToolNames(record: Pick<RecordedRequest, "head" | "list">, { eager = false } = {}): Set<string> {
	return new Set([...declaredToolNames(record.head, { eager }), ...loadedInList(record.list)]);
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
	return withRequestFields(underRecordedHead(base, payload, api, list), payload);
}

/**
 * The tools a Responses list declares itself: a leading `additional_tools`
 * item (pi 1.4.0 and later), and the items a `tool_search` load rides (an
 * `additional_tools` item, a `tool_search_output`). pi renders a loaded tool
 * eager again once its load is in the recorded prefix, and the head must not
 * declare it twice.
 */
export function loadedInList(list: readonly unknown[]): Set<string> {
	return new Set(listDeclarations(list).keys());
}

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
import type { RequestIdentity, RequestRecordData } from "./records.ts";

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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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

/** JSON with sorted keys, so key order never changes a hash; `undefined` fields drop out as in JSON. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
	if (!isObject(value)) return JSON.stringify(value) ?? "null";
	const fields = Object.keys(value)
		.filter((key) => value[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
	return `{${fields.join(",")}}`;
}

/** A stable content hash of `value`: object key order does not matter, cache markers are ignored. */
export function contentHash(value: unknown): string {
	return createHash("sha256").update(canonical(stripMarkers(value))).digest("hex");
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

const sameIdentity = (a: RequestIdentity, b: RequestIdentity) => a.api === b.api && a.provider === b.provider && a.model === b.model && a.auth === b.auth;

/**
 * The record for `payload`, or undefined when it adds nothing: the same list
 * and head as `previous` (a pi cache warm or a provider retry re-running the
 * hooks). `known` is every hash already on the branch, so `blobs` carries only
 * new bodies.
 */
export function encodeRequest(
	previous: RecordedRequest | undefined,
	payload: WirePayload,
	identity: RequestIdentity,
	known: ReadonlySet<string>,
): Omit<RequestRecordData, "v" | "by" | "consumed"> | undefined {
	const list = stripMarkers(payloadList(payload, identity.api));
	const hashes = list.map(contentHash);
	const head = payloadHead(payload, identity.api);
	const headHash = contentHash(head);

	let keep = 0;
	if (previous) while (keep < hashes.length && keep < previous.hashes.length && hashes[keep] === previous.hashes[keep]) keep++;
	const unchanged = previous && keep === hashes.length && keep === previous.hashes.length && headHash === previous.headHash && sameIdentity(identity, previous.identity);
	if (unchanged) return undefined;

	const blobs: Record<string, unknown> = {};
	for (let i = keep; i < list.length; i++) if (!known.has(hashes[i])) blobs[hashes[i]] = list[i];
	if (!known.has(headHash)) blobs[headHash] = head;
	return { identity, keep, append: hashes.slice(keep), head: headHash, blobs };
}

/**
 * The payload with every element up to `recorded.list.length` taken from the
 * record, and the indexes where pi's own serialization differed. The tail
 * past the record is left as pi built it; the head is untouched (a new epoch
 * renders it). An element pi serialized identically keeps pi's cache markers.
 * A recorded element past the end of pi's list is not added back; the
 * validator reports it.
 */
export function enforcePrefix(recorded: RecordedRequest, payload: WirePayload, api: string): { payload: WirePayload; replaced: number[] } {
	const list = payloadList(payload, api).slice();
	const replaced: number[] = [];
	const end = Math.min(recorded.list.length, list.length);
	for (let i = 0; i < end; i++) {
		if (contentHash(list[i]) === recorded.hashes[i]) continue;
		list[i] = structuredClone(recorded.list[i]);
		replaced.push(i);
	}
	return { payload: replaced.length ? { ...payload, [listKey(api)]: list } : payload, replaced };
}

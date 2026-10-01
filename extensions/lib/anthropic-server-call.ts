/**
 * The I/O half of the native web tools: one streamed Messages call carrying
 * an Anthropic server tool, folded by `anthropic-server-tools.ts`.
 *
 * A raw `fetch` rather than pi's `completeSimple`: pi's stream parser drops
 * `server_tool_use` and `web_*_tool_result` blocks, and those carry what
 * decides between the answer and the fallback. Streamed because a
 * non-streaming call with server tools can sit past undici's five-minute
 * headers timeout (findings §43).
 */

import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import {
	createServerCallAccumulator,
	nativeEligibility,
	type Outcome,
	parseSseBuffer,
	pickNativeWebModel,
	type ServerCallResult,
	type ThinkingFields,
	thinkingOff,
	thinkingRetry,
	tokenCounts,
	WEB_SEARCH_COST_PER_REQUEST,
} from "./anthropic-server-tools.ts";

import { modelSpec } from "./model-policy.ts";

/** Observed calls take 8 to 16 s; a stuck one gives way to the fallback. */
const NATIVE_CALL_TIMEOUT_MS = 120_000;

/** pi's header maps: a `null` value removes that header. */
type HeaderMap = Record<string, string | null>;

export interface ServerCallAuth {
	apiKey: string;
	headers?: HeaderMap;
	baseUrl?: string;
}

interface ServerCallReply {
	result: ServerCallResult;
	/** pi's usage shape with the cost filled in, searches included. */
	usage: Usage;
}

/** pi's `Usage` for one call: token cost from the catalog price, plus Anthropic's per-search fee. */
export function serverCallUsage(model: Model<Api>, result: ServerCallResult): Usage {
	const usage: Usage = { ...tokenCounts(result.usage), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	usage.cost = calculateCost(model, usage);
	const searches = result.usage.server_tool_use?.web_search_requests ?? 0;
	usage.cost = { ...usage.cost, total: usage.cost.total + searches * WEB_SEARCH_COST_PER_REQUEST };
	return usage;
}

/**
 * Run one call. The thinking-off fields for `model` are merged into `body`; a
 * 400 that rejects them is retried once with the fields the error names, and
 * `learned` (per extension, keyed by `provider/id`) remembers those so later
 * calls send them first. Throws on any other HTTP error, a timeout or a
 * cancel; the caller falls back.
 */
export async function runServerCall(
	model: Model<Api>,
	auth: ServerCallAuth,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	learned?: Map<string, ThinkingFields>,
): Promise<ServerCallReply> {
	const url = `${(auth.baseUrl ?? model.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries({ ...(model.headers as HeaderMap | undefined), ...auth.headers })) {
		if (value !== null) headers[name] = value;
	}
	Object.assign(headers, {
		"content-type": "application/json",
		accept: "text/event-stream",
		"anthropic-version": "2023-06-01",
		"x-api-key": auth.apiKey,
	});
	const timeout = AbortSignal.timeout(NATIVE_CALL_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	const key = modelSpec(model);
	let thinking = learned?.get(key) ?? thinkingOff(model);
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, ...thinking }), signal: combined });
		if (!response.ok) {
			const text = await response.text();
			const message = errorMessage(text);
			const retry = response.status === 400 && attempt === 0 ? thinkingRetry(message) : undefined;
			if (retry) {
				thinking = retry;
				continue;
			}
			throw new Error(`Anthropic API error (${response.status}): ${message}`);
		}
		// Remembered only once the model accepted them, so an unrelated 400 that
		// happens to name a switch cannot pin wrong fields for the session.
		if (attempt > 0) learned?.set(key, thinking);
		const accumulator = createServerCallAccumulator();
		try {
			await readStream(response, accumulator);
		} catch (error) {
			// The tokens and searches streamed before the break were still billed.
			throw new ServerCallError((error as Error).message, serverCallUsage(model, accumulator.result()), error);
		}
		const result = accumulator.result();
		return { result, usage: serverCallUsage(model, result) };
	}
}

/** The slice of pi's model registry the resolver reads. */
interface RegistryLike {
	getAvailable(): Model<Api>[];
	getApiKeyAndHeaders(
		model: Model<Api>,
	): Promise<{ ok: true; apiKey?: string; headers?: HeaderMap; baseUrl?: string } | { ok: false; error: string }>;
}

type NativeWebTarget = { ok: true; model: Model<Api>; auth: ServerCallAuth } | { ok: false; reason: string };

/**
 * Whether this session runs the native web tools, and on which model with
 * which credentials. Not-eligible is the normal case on every other provider,
 * so callers use the reason only for diagnostics, never in a result.
 */
async function resolveNativeWeb(ctx: { model?: Model<Api>; modelRegistry: RegistryLike }): Promise<NativeWebTarget> {
	const session = ctx.model;
	if (!session || session.provider !== "anthropic") return { ok: false, reason: "not an Anthropic session" };
	const sessionAuth = await ctx.modelRegistry.getApiKeyAndHeaders(session);
	if (!sessionAuth.ok) return { ok: false, reason: sessionAuth.error };
	const eligible = nativeEligibility({ sessionModel: session, baseUrl: sessionAuth.baseUrl, apiKey: sessionAuth.apiKey });
	if (!eligible.ok) return eligible;
	const model = pickNativeWebModel(ctx.modelRegistry.getAvailable(), session);
	if (!model) return { ok: false, reason: "no model on this provider supports dynamic filtering (Claude 4.6 or later)" };
	// The pick is same-provider, but its credentials are resolved on their own
	// and checked again: a per-model base URL or key must not slip past the gate.
	const auth = model === session ? sessionAuth : await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey || !nativeEligibility({ sessionModel: model, baseUrl: auth.baseUrl, apiKey: auth.apiKey }).ok) {
		return { ok: false, reason: `no usable credentials for ${model.provider}/${model.id}` };
	}
	return { ok: true, model, auth: { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl } };
}

export type NativeAttempt =
	/** The session cannot use the native tools; today's path runs with no note. */
	| { kind: "skipped" }
	| { kind: "answered"; text: string; cutOff: boolean; spec: string; result: ServerCallResult }
	/** The call ran and did not answer; `reason` goes into the fallback's note. */
	| { kind: "fell-back"; reason: string }
	| { kind: "cancelled" };

/**
 * The native step both web tools share: resolve, call, report usage, and
 * decide with `outcome` whether the call answered. Never throws: a failure
 * is a `fell-back` with the reason, a cancel is `cancelled`.
 */
export async function tryNativeWeb(
	ctx: { model?: Model<Api>; modelRegistry: RegistryLike },
	request: {
		body: (modelId: string) => Record<string, unknown>;
		outcome: (result: ServerCallResult) => Outcome;
		onUsage: (usage: Usage) => void;
		/** Called once the native path is chosen, before the call (a progress update). */
		onStart?: (spec: string) => void;
		/** The caller's per-session memo of each model's thinking-off fields. */
		learned?: Map<string, ThinkingFields>;
		signal: AbortSignal | undefined;
	},
): Promise<NativeAttempt> {
	const native = await resolveNativeWeb(ctx);
	if (!native.ok) return { kind: "skipped" };
	const spec = modelSpec(native.model);
	request.onStart?.(spec);
	try {
		const reply = await runServerCall(native.model, native.auth, request.body(native.model.id), request.signal, request.learned);
		request.onUsage(reply.usage);
		const outcome = request.outcome(reply.result);
		return outcome.ok
			? { kind: "answered", text: outcome.text, cutOff: outcome.cutOff, spec, result: reply.result }
			: { kind: "fell-back", reason: outcome.reason };
	} catch (error) {
		if (error instanceof ServerCallError && error.usage.totalTokens > 0) request.onUsage(error.usage);
		if (request.signal?.aborted) return { kind: "cancelled" };
		return { kind: "fell-back", reason: `the call failed: ${(error as Error).message}` };
	}
}

function errorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		return parsed.error?.message ?? body;
	} catch {
		return body;
	}
}

/** A stream that broke after it started, with the usage it had reported by then. */
class ServerCallError extends Error {
	constructor(
		message: string,
		readonly usage: Usage,
		cause: unknown,
	) {
		super(message, { cause });
	}
}

async function readStream(response: Response, accumulator: ReturnType<typeof createServerCallAccumulator>): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Anthropic API returned no response body");
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
		const { events, rest } = parseSseBuffer(done ? `${buffer}\n\n` : buffer);
		buffer = rest;
		for (const event of events) accumulator.push(event);
		if (done) break;
	}
}

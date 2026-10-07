/**
 * The side calls (btw, recap, the web_fetch reader) must put the same request
 * on the wire as the inline code they shared before `runSideCall`: the same
 * per-session cache key, the same cache breakpoints, the same base URL. Each
 * case drives the extension with `completeSimple` mocked, then sends both the
 * arguments it received and the ones the earlier inline code built (frozen
 * below as the reference) through pi-ai's real provider adapter, and compares
 * the bytes each would send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import btwExtension from "../../extensions/btw/index.ts";
import recapExtension from "../../extensions/recap/index.ts";
import webFetchExtension from "../../extensions/web-fetch/index.ts";
import { cacheSideCallConversation, SIDE_CALL_CACHE_APIS } from "../../extensions/lib/side-call-cache.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
vi.mock("../../extensions/lib/side-call-usage.ts", () => ({ logSideCallUsage: vi.fn() }));

const complete = vi.mocked(completeSimple);
const answer = { content: [{ type: "text", text: "An answer." }], stopReason: "stop", usage: {} } as Awaited<ReturnType<typeof completeSimple>>;
const auth = { ok: true, apiKey: "test-key", headers: { "x-test": "yes" }, env: { PI_CACHE_RETENTION: "short" }, baseUrl: "https://proxy.example/v1" };
const SESSION = "wire-session";

function modelFor(api: "anthropic-messages" | "openai-completions"): Model<Api> {
	const anthropic = api === "anthropic-messages";
	return {
		provider: anthropic ? "anthropic" : "openrouter",
		id: anthropic ? "claude-wire" : "anthropic/claude-wire",
		name: "Wire model",
		api,
		baseUrl: anthropic ? "https://api.anthropic.com" : "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 8192,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

/** The bytes a provider adapter would send for these arguments: URL, headers and body. */
async function wire(model: Model<Api>, context: Context, options: SimpleStreamOptions): Promise<string> {
	let sent: string | undefined;
	const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		sent = JSON.stringify({ url: String(url), headers, body: init?.body });
		throw new Error("Captured before dispatch");
	});
	const stream = model.api === "anthropic-messages" ? anthropicStream : completionsStream;
	const { signal: _signal, ...rest } = options;
	await stream(model as never, normalizeContext(context), { ...rest, fetch, maxRetries: 0 } as never).result();
	expect(fetch).toHaveBeenCalledTimes(1);
	return sent!;
}

/** What the inline side-call code passed to `completeSimple` before `runSideCall`. */
function inlineReference(kind: "btw" | "recap" | "reader", model: Model<Api>): [Model<Api>, SimpleStreamOptions] {
	const maxTokens = { btw: 8192, recap: 256, reader: 4_000 }[kind];
	const sessionId = `${SESSION}:${kind}`;
	const options: SimpleStreamOptions = kind === "reader"
		? { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, sessionId, signal: new AbortController().signal, maxTokens }
		: {
			apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: new AbortController().signal, maxTokens, sessionId,
			...(SIDE_CALL_CACHE_APIS.has(model.api) ? { onPayload: cacheSideCallConversation } : {}),
		};
	return [{ ...model, baseUrl: auth.baseUrl } as Model<Api>, options];
}

function baseCtx(model: Model<Api>) {
	return createFakeCtx({
		mode: "rpc",
		hasUI: true,
		model,
		sessionManager: { getSessionId: () => SESSION, getBranch: () => [] },
		modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => auth },
	});
}

const history = [
	{ role: "user", content: "Earlier question about the build.", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "Earlier answer: run the tests first." }], api: "anthropic-messages", provider: "anthropic", model: "claude-wire", usage: {}, stopReason: "stop", timestamp: 2 },
];

async function drive(kind: "btw" | "recap" | "reader", model: Model<Api>): Promise<void> {
	const fake = createFakePi();
	const ctx = baseCtx(model);
	if (kind === "btw") {
		btwExtension(fake.pi as never);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("context", { messages: history }, ctx);
		await fake.commands.get("btw")!.handler("What did we decide?", ctx);
	} else if (kind === "recap") {
		vi.useFakeTimers();
		process.env.CC_RECAP_IDLE_MS = "1000";
		recapExtension(fake.pi as never);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("context", { messages: history }, ctx);
		await fake.fire("agent_settled", {}, ctx);
		await vi.advanceTimersByTimeAsync(1000);
		vi.useRealTimers();
		await vi.waitFor(() => expect(complete).toHaveBeenCalled());
	} else {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("Hello from the page.", { headers: { "content-type": "text/plain" } })));
		webFetchExtension(fake.pi as never);
		await fake.tools.get("web_fetch")!.execute("fetch-id", { url: "https://127.0.0.1/wire", prompt: "What does it say?" }, undefined, undefined, ctx);
	}
}

beforeEach(() => {
	complete.mockReset().mockResolvedValue(answer);
	delete process.env.CC_RECAP;
});
afterEach(() => {
	delete process.env.CC_RECAP_IDLE_MS;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("side calls put the same request on the wire", () => {
	const cases = (["btw", "recap", "reader"] as const).flatMap((kind) => (["anthropic-messages", "openai-completions"] as const).map((api) => [kind, api] as const));
	it.each(cases)("%s on %s", async (kind, api) => {
		const model = modelFor(api);
		await drive(kind, model);
		expect(complete).toHaveBeenCalledTimes(1);
		const [sentModel, context, options] = complete.mock.calls[0]!;
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		// Anthropic's body does not carry the key, so check it here as well as on the wire.
		expect(options?.sessionId).toBe(`${SESSION}:${kind}`);
		const [referenceModel, referenceOptions] = inlineReference(kind, model);
		const actual = await wire(sentModel, context, options!);
		expect(actual).toBe(await wire(referenceModel, context, referenceOptions));
		expect(actual).toContain("https://proxy.example/v1");
		if (kind !== "reader") expect(actual).toContain("cache_control");
	});
});

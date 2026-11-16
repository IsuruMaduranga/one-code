/**
 * The threadless Anthropic streams send exactly the credentials pi's own
 * provider sends. A real pi ModelRuntime resolves each credential, a stub
 * `fetch` records the request headers, and each case compares a request with
 * the `anthropic` wrapper registered (and a side call through
 * `completeThreadless`, which sends through the runtime) against the same
 * request with no wrapper. The last cases cover what only the runtime knows:
 * a missing credential, an extension provider's own stream, a virtual model.
 */
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeThreadless, threadlessAnthropicRegistration } from "../../extensions/lib/request/anthropic-stream.ts";

const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
	saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
	for (const name of ENV) delete process.env[name];
});
afterEach(() => {
	for (const name of ENV) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
});

type Headers = Record<string, string>;
type Credential = { type: "api_key"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number };

/** The credential headers of a request, plus whether its body asked for a message thread. */
interface Sent { auth: string | null; key: string | null; headers: Headers; thread: boolean }

function recorder() {
	const sent: Sent[] = [];
	const fetch = async (_input: unknown, init?: RequestInit) => {
		const headers: Headers = {};
		new globalThis.Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		sent.push({ auth: headers.authorization ?? null, key: headers["x-api-key"] ?? null, headers, thread: "thread" in body });
		return new Response('{"type":"error","error":{"type":"api_error","message":"stub"}}', { status: 500, headers: { "content-type": "application/json" } });
	};
	return { sent, fetch };
}

async function runtime(credential?: Credential): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: {
			read: async (provider: string) => (provider === "anthropic" ? credential : undefined),
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		} as never,
		modelsPath: null,
		refreshOnCreate: false,
	});
}

const context = { systemPrompt: "Be brief.", messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

/** One session request through pi's runtime, and one side call through the same runtime (the side calls pass `ctx.modelRegistry`). */
async function send(rt: ModelRuntime, model: Model<Api>): Promise<{ session: Sent; side: Sent }> {
	const { sent, fetch } = recorder();
	await rt.streamSimple(model, context, { fetch, maxRetries: 0 } as never).result();
	await completeThreadless(new ModelRegistry(rt), model, context, { fetch, maxRetries: 0 } as never);
	expect(sent).toHaveLength(2);
	return { session: sent[0], side: sent[1] };
}

/** What pi sends alone, then the same with the wrapper registered; the wrapper's calls are counted. */
async function compare(credential: Credential | undefined, pick: (rt: ModelRuntime) => Model<Api>, setup?: (rt: ModelRuntime) => void) {
	const plain = await runtime(credential);
	setup?.(plain);
	const before = await send(plain, pick(plain));

	const wrapped = await runtime(credential);
	setup?.(wrapped);
	const registration = threadlessAnthropicRegistration();
	expect(registration).toBeDefined();
	let calls = 0;
	wrapped.registerProvider("anthropic", {
		api: registration!.api,
		streamSimple: (model, ctx, options) => {
			calls++;
			return registration!.streamSimple(model, ctx, options);
		},
	});
	const after = await send(wrapped, pick(wrapped));
	return { before, after, calls };
}

const anthropicModel = (rt: ModelRuntime) => rt.getModel("anthropic", "claude-haiku-4-5") ?? rt.getModels("anthropic")[0];

describe("threadless Anthropic streams send pi's credentials, nothing more", () => {
	it("an API key only: x-api-key alone, as pi sends it", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-KEY";
		const { before, after, calls } = await compare(undefined, anthropicModel);
		// The session request and the side call both reach the registered wrapper.
		expect(calls).toBe(2);
		expect(before.session).toMatchObject({ auth: null, key: "sk-ant-api-KEY" });
		expect(after.session.headers).toEqual(before.session.headers);
		expect(after.side.headers).toEqual(before.session.headers);
	});

	it("a login (bearer) only: Authorization alone, as pi sends it", async () => {
		const login: Credential = { type: "oauth", access: "sk-ant-oat01-LOGIN", refresh: "sk-ant-ort01-R", expires: Date.now() + 3_600_000 };
		const { before, after, calls } = await compare(login, anthropicModel);
		expect(calls).toBe(2);
		expect(before.session).toMatchObject({ auth: "Bearer sk-ant-oat01-LOGIN", key: null });
		expect(after.session.headers).toEqual(before.session.headers);
		expect(after.side.headers).toEqual(before.session.headers);
	});

	it("ANTHROPIC_AUTH_TOKEN with ANTHROPIC_API_KEY also exported: the bearer token alone, no x-api-key", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-SECRET";
		const { before, after, calls } = await compare(undefined, anthropicModel);
		expect(calls).toBe(2);
		expect(before.session).toMatchObject({ auth: "Bearer gateway-token", key: null });
		expect(after.session.headers).toEqual(before.session.headers);
		expect(after.side.headers).toEqual(before.session.headers);
		expect(after.side.key).toBeNull();
	});

	it("a custom provider on anthropic-messages with its own key: its key alone, with the Anthropic key exported", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-SECRET";
		const custom = (rt: ModelRuntime) =>
			rt.registerProvider("my-gateway", {
				baseUrl: "https://gateway.example/anthropic",
				apiKey: "gateway-own-key",
				api: "anthropic-messages",
				models: [{ id: "claude-haiku-4-5", name: "Haiku", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
			} as never);
		const { before, after, calls } = await compare(undefined, (rt) => rt.getModel("my-gateway", "claude-haiku-4-5")!, custom);
		expect(calls).toBe(0);
		expect(before.session).toMatchObject({ auth: null, key: "gateway-own-key" });
		expect(after.session.headers).toEqual(before.session.headers);
		expect(after.side.headers).toEqual(before.session.headers);
	});

	it("the wrapper keeps a session request's message threads off, which pi turns on with a session id", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-KEY";
		// pi-ai asks for a thread only with a session id: without one, `thread: false` would hold whatever the wrapper did.
		const sessionThread = async (wrap: boolean) => {
			const rt = await runtime();
			if (wrap) rt.registerProvider("anthropic", threadlessAnthropicRegistration()!);
			const { sent, fetch } = recorder();
			await rt.streamSimple(anthropicModel(rt), context, { fetch, maxRetries: 0, sessionId: "session-thread" } as never).result();
			expect(sent).toHaveLength(1);
			return sent[0].thread;
		};
		expect(await sessionThread(false)).toBe(true);
		expect(await sessionThread(true)).toBe(false);
	});

	it("a side call keeps message threads off on a provider that does not go through the wrapper", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-KEY";
		const rt = await runtime();
		const { sent, fetch } = recorder();
		// pi-ai asks for a thread only with a session id: without one, `thread: false` would hold whatever the side call did.
		await completeThreadless(new ModelRegistry(rt), anthropicModel(rt), context, { fetch, maxRetries: 0, sessionId: "thread-suppression" } as never);
		expect(sent).toHaveLength(1);
		expect(sent[0].thread).toBe(false);
	});
});

describe("side calls go through pi's model runtime", () => {
	it("no credential pi would use: an error reply naming the provider, nothing sent", async () => {
		const rt = await runtime();
		const { sent, fetch } = recorder();
		const reply = await completeThreadless(new ModelRegistry(rt), anthropicModel(rt), context, { fetch, maxRetries: 0 } as never);
		expect(sent).toHaveLength(0);
		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toMatch(/anthropic/);
		// The refusal names the model, the cause and the fix, not pi's bare "Provider is not configured".
		expect(reply.credentialError).toBe("Provider is not configured: anthropic");
		expect(reply.errorMessage).toBe(`No usable credentials for anthropic/${anthropicModel(rt).id}: Provider is not configured: anthropic. Log in with /login or set the provider's API key.`);
	});

	it("an extension provider with its own api and stream is reached (compat had no API for it)", async () => {
		const rt = await runtime();
		const seen: { model: string; apiKey?: string }[] = [];
		rt.registerProvider("my-ext", {
			baseUrl: "https://ext.example/v1",
			apiKey: "ext-own-key",
			api: "my-ext-api",
			models: [{ id: "ext-1", name: "Ext", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000 }],
			streamSimple: (model: Model<Api>, _ctx: unknown, options?: { apiKey?: string }) => {
				seen.push({ model: model.id, apiKey: options?.apiKey });
				return replyStream(model, "from the extension");
			},
		} as never);
		const reply = await completeThreadless(new ModelRegistry(rt), rt.getModel("my-ext", "ext-1")!, context, { maxRetries: 0 } as never);
		expect(reply.stopReason).toBe("stop");
		expect(seen).toEqual([{ model: "ext-1", apiKey: "ext-own-key" }]);
	});

	it("a virtual model is routed to its physical model, which resolves its own credential", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-KEY";
		const rt = await runtime();
		const physical = anthropicModel(rt);
		await rt.refresh({ allowNetwork: false });
		rt.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route: () => ({ model: physical, thinkingLevel: "off" }) });
		const { sent, fetch } = recorder();
		const reply = await completeThreadless(new ModelRegistry(rt), rt.getModel("router", "auto")!, context, { fetch, maxRetries: 0 } as never);
		expect(reply.errorMessage ?? "").toMatch(/stub/);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ key: "sk-ant-api-KEY" });
	});

	// completeThreadless turns threads off on the model it is given, which for a
	// virtual model is not the one the router picks: a routed Anthropic model
	// keeps them off through the `anthropic` registration (request/ledger/wire.ts).
	it("a virtual model routed to Anthropic keeps message threads off through the provider registration", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-KEY";
		const rt = await runtime();
		const registration = threadlessAnthropicRegistration()!;
		rt.registerProvider("anthropic", { api: registration.api, streamSimple: registration.streamSimple });
		const physical = anthropicModel(rt);
		await rt.refresh({ allowNetwork: false });
		rt.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route: () => ({ model: physical, thinkingLevel: "off" }) });
		const { sent, fetch } = recorder();
		await completeThreadless(new ModelRegistry(rt), rt.getModel("router", "auto")!, context, { fetch, maxRetries: 0, sessionId: "thread-suppression" } as never);
		expect(sent).toHaveLength(1);
		expect(sent[0].thread).toBe(false);
	});
});

/** A finished one-text-block reply as a pi-ai event stream. */
function replyStream(model: Model<Api>, text: string) {
	const stream = new AssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 1,
	};
	queueMicrotask(() => {
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

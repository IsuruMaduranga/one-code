/**
 * The threadless Anthropic streams send exactly the credentials pi's own
 * provider sends. A real pi ModelRuntime resolves each credential, a stub
 * `fetch` records the request headers, and each case compares a request with
 * the `anthropic` wrapper registered (and a side call through
 * `completeThreadless`) against the same request with no wrapper.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
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

/** One session request through pi's runtime, and one side call the way the side calls resolve auth (modelRegistry.getApiKeyAndHeaders). */
async function send(rt: ModelRuntime, model: Model<Api>): Promise<{ session: Sent; side: Sent }> {
	const { sent, fetch } = recorder();
	await rt.streamSimple(model, context, { fetch, maxRetries: 0 } as never).result();
	const resolution = await rt.getAuth(model);
	await completeThreadless(model, context, {
		apiKey: resolution?.auth.apiKey,
		headers: resolution?.auth.headers,
		env: resolution?.env,
		fetch,
		maxRetries: 0,
	} as never);
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
		expect(calls).toBe(1);
		expect(before.session).toMatchObject({ auth: null, key: "sk-ant-api-KEY" });
		expect(after.session.headers).toEqual(before.session.headers);
		expect(after.side.headers).toEqual(before.session.headers);
		expect(after.session.thread).toBe(false);
	});

	it("a login (bearer) only: Authorization alone, as pi sends it", async () => {
		const login: Credential = { type: "oauth", access: "sk-ant-oat01-LOGIN", refresh: "sk-ant-ort01-R", expires: Date.now() + 3_600_000 };
		const { before, after, calls } = await compare(login, anthropicModel);
		expect(calls).toBe(1);
		expect(before.session).toMatchObject({ auth: "Bearer sk-ant-oat01-LOGIN", key: null });
		expect(after.session.headers).toEqual(before.session.headers);
		expect(after.side.headers).toEqual(before.session.headers);
	});

	it("ANTHROPIC_AUTH_TOKEN with ANTHROPIC_API_KEY also exported: the bearer token alone, no x-api-key", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-SECRET";
		const { before, after, calls } = await compare(undefined, anthropicModel);
		expect(calls).toBe(1);
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
});

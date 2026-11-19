/**
 * The pi facts a Codex fork's cache depends on (findings §75), checked
 * offline so a pi bump that changes either fails here instead of at the live
 * cache matrix. `withParentSessionId` (lib/agents/agent-loader.ts) hands a
 * fork's runtime the parent's session id, and that works only while:
 *
 * 1. pi's SDK passes the session's id to `modelRuntime.streamSimple` as
 *    `options.sessionId` (the proxy matches on it and replaces it);
 * 2. pi-ai's Codex provider builds the request's routing from that value
 *    alone: the `session-id` and `x-client-request-id` headers and the body's
 *    `prompt_cache_key`, after any extension header.
 *
 * When pi lets a session route under another id (the upstream request in
 * features/agent-wait/upstream-pi-provider-session-id.md), the proxy and
 * this test go.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openChildSession, withParentSessionId } from "../../extensions/lib/agents/agent-loader.ts";

const dir = mkdtempSync(join(tmpdir(), "oc-codex-fork-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const codex = {
	id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1000,
} as const;

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("pi's SDK hands the session id to the model runtime", () => {
	it("as options.sessionId, so a fork's runtime can put the parent's id there", async () => {
		const runtime = await ModelRuntime.create({
			credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
			modelsPath: null,
			refreshOnCreate: false,
		});
		vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
		const seen: Array<string | undefined> = [];
		vi.spyOn(runtime, "streamSimple").mockImplementation(((_model: unknown, _context: unknown, options?: { sessionId?: string }) => {
			seen.push(options?.sessionId);
			const reply: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "ok" }], api: codex.api, provider: codex.provider, model: codex.id, timestamp: 1, stopReason: "stop", usage };
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: reply });
			events.push({ type: "done", reason: "stop", message: reply });
			return events;
		}) as never);

		const run = async (fork: boolean) => {
			const sessionManager = SessionManager.inMemory(dir);
			const session = await openChildSession({
				loader: { cwd: dir, agentDir: dir, noContextFiles: true },
				session: {
					cwd: dir,
					agentDir: dir,
					modelRuntime: fork ? withParentSessionId(runtime, "parent-session", () => sessionManager.getSessionId()) : runtime,
					model: codex as never,
					sessionManager,
				},
			});
			try {
				await session.prompt("hi");
			} finally {
				session.dispose();
			}
			return sessionManager.getSessionId();
		};

		const own = await run(false);
		expect(seen).toEqual([own]);
		await run(true);
		expect(seen.at(-1)).toBe("parent-session");
	});
});

describe("pi-ai's Codex provider routes by options.sessionId alone", () => {
	/** A token pi-ai accepts: a JWT whose auth claim names a ChatGPT account. */
	const token = ["e30", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url"), "sig"].join(".");

	it("puts it in the session-id and x-client-request-id headers, over an extension's, and in prompt_cache_key", async () => {
		let headers: Headers | undefined;
		let body: Record<string, unknown> | undefined;
		const fetch = vi.fn(async (_url: unknown, init?: { headers?: ConstructorParameters<typeof Headers>[0] }) => {
			headers = new Headers(init?.headers);
			return new Response("{}", { status: 400 });
		});
		const events = streamSimple(codex as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
			apiKey: token,
			sessionId: "parent-session",
			transport: "sse",
			maxRetries: 0,
			fetch,
			headers: { "session-id": "set-by-an-extension" },
			onPayload: (payload: unknown) => {
				body = payload as Record<string, unknown>;
				return undefined;
			},
		} as never);
		for await (const _event of events) {
			// drain: the stubbed 400 ends it with an error
		}
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(headers?.get("session-id")).toBe("parent-session");
		expect(headers?.get("x-client-request-id")).toBe("parent-session");
		expect(body?.prompt_cache_key).toBe("parent-session");
	});
});

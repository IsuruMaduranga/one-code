import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import webFetchExtension from "../../extensions/web-fetch/index.ts";
import { readerMessages } from "../../extensions/web-fetch/summarize.ts";
import { logSideCallUsage } from "../../extensions/lib/side-call-usage.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
vi.mock("../../extensions/lib/side-call-usage.ts", () => ({ logSideCallUsage: vi.fn() }));

const complete = vi.mocked(completeSimple);
const reply = (stopReason = "stop", errorMessage?: string) => ({
	content: [{ type: "text", text: "The page says hello." }], stopReason, errorMessage,
	usage: { input: 20, output: 5, cacheRead: 1024, cacheWrite: 0 },
}) as AssistantMessage;
const page = "Hello from the page.\nKeep exact whitespace and Unicode: 😀 café.";
const url = "https://127.0.0.1/cache-reader-test";

function setup(api = "openai-codex-responses") {
	const model = { provider: "test-provider", id: "reader-model", api, input: ["text"], cost: { input: 1, output: 2 } };
	let sessionId = "reader-session";
	const ctx = createFakeCtx({
		model,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "yes" }, env: { PI_CACHE_RETENTION: "short" } }),
		},
	});
	const fake = createFakePi();
	webFetchExtension(fake.pi as never);
	return {
		fake, ctx,
		switchSession: (id: string) => { sessionId = id; },
		fetch: (prompt = "What does the page say?") => fake.tools.get("web_fetch")!.execute("fetch-id", { url, prompt }, undefined, undefined, ctx),
	};
}

beforeEach(() => {
	complete.mockReset().mockResolvedValue(reply());
	vi.mocked(logSideCallUsage).mockClear();
	vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { headers: { "content-type": "text/plain" } })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("web-fetch reader cache affinity", () => {
	it.each(["anthropic-messages", "openai-responses", "openai-codex-responses", "openai-completions"])("passes one session reader key across %s calls", async (api) => {
		const t = setup(api);
		await t.fetch();
		await t.fetch("Another question?");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls.map((call) => call[2]?.sessionId)).toEqual(["reader-session:reader", "reader-session:reader"]);
		// A cached download still invokes the reader, with exactly the old prompt bytes.
		expect(fetch).toHaveBeenCalledTimes(1);
		for (const [index, prompt] of ["What does the page say?", "Another question?"].entries()) {
			const expected = readerMessages({ prompt, markdown: page, url });
			expect(complete.mock.calls[index][1]).toEqual({
				systemPrompt: expected.system,
				messages: [{ role: "user", content: expected.user, timestamp: expect.any(Number) }],
			});
		}
		expect(complete.mock.calls[0][1].systemPrompt).toBe(complete.mock.calls[1][1].systemPrompt);
	});

	it("uses the new session's key after a session switch", async () => {
		const t = setup();
		await t.fetch();
		t.switchSession("new-session");
		await t.fake.fire("session_start", {}, t.ctx);
		await t.fetch();
		expect(complete.mock.calls.map((call) => call[2]?.sessionId)).toEqual(["reader-session:reader", "new-session:reader"]);
	});

	it("keeps the key and input bytes on the required-reasoning retry", async () => {
		complete.mockResolvedValueOnce(reply("error", "Reasoning is mandatory for this endpoint"));
		const t = setup();
		await t.fetch();
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls.map((call) => call[2]?.sessionId)).toEqual(["reader-session:reader", "reader-session:reader"]);
		expect(complete.mock.calls[0][1].messages[0].content).toBe(complete.mock.calls[1][1].messages[0].content);
		expect(complete.mock.calls[1][2]?.reasoning).toBeDefined();
		expect(logSideCallUsage).toHaveBeenCalledTimes(2);
		for (const [index, logged] of vi.mocked(logSideCallUsage).mock.calls.entries()) {
			expect(logged[0]).toMatchObject({
				kind: "reader", sessionId: "reader-session:reader",
				system: complete.mock.calls[index][1].systemPrompt,
				messages: complete.mock.calls[index][1].messages,
			});
			expect(logged[1].stopReason).toBe(index === 0 ? "error" : "stop");
		}
	});
});

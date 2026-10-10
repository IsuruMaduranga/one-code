import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webExtension from "../../extensions/web/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const mocks = vi.hoisted(() => ({ callApiStream: vi.fn() }));
vi.mock("pi-web-search/src/api.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("pi-web-search/src/api.ts")>(),
	callApiStream: mocks.callApiStream,
}));
vi.mock("pi-web-search/src/utils.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("pi-web-search/src/utils.ts")>(),
	getWebSearchModel: async () => ({ provider: "google", api: "google-generative-ai", id: "gemini-test" }),
}));
vi.mock("../../extensions/lib/anthropic-server-call.ts", () => ({ tryNativeWeb: async () => ({ kind: "unavailable" }) }));

type Result = { content: Array<{ type: string; text: string }>; details: { backend?: string; error?: unknown }; isError?: boolean };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-search-native-"));
	mocks.callApiStream.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

async function execute(signal?: AbortSignal): Promise<Result> {
	const fake = createFakePi();
	webExtension(fake.pi as never);
	const ctx = createFakeCtx({
		model: { provider: "google", api: "google-generative-ai", id: "gemini-test" },
		sessionManager: { getSessionDir: () => dir },
	});
	return await fake.tools.get("web_search")!.execute("search-native", { query: "test search" }, signal, undefined, ctx) as Result;
}

describe("provider-native search results", () => {
	it("persists the whole oversized answer, including its tail and sources", async () => {
		const answer = "full search answer ".repeat(4000) + "TAIL_SENTINEL";
		mocks.callApiStream.mockResolvedValue({ text: answer, sources: [{ title: "Example", url: "https://example.com/tail" }] });
		const result = await execute();
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("<persisted-output>");
		const saved = readFileSync(join(dir, "tool-results", "search-native.txt"), "utf8");
		expect(saved).toContain(answer);
		expect(saved).toContain("https://example.com/tail");
		expect(saved).not.toContain("[Truncated]");
	});

	it("labels the provider in the model-facing result", async () => {
		mocks.callApiStream.mockResolvedValue({ text: "Search answer", sources: [{ title: "Example", url: "https://example.com" }] });
		const result = await execute();
		expect(result.content.map((block) => block.text).join("\n")).toContain("google/gemini-test");
	});

	it("falls back to a configured backend after a native failure and states why", async () => {
		mocks.callApiStream.mockRejectedValue(new Error("native search unavailable"));
		vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
		const fetch = vi.fn(async () => new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com", description: "Result snippet" }] } }), { headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetch);
		const result = await execute();
		expect(result.isError).not.toBe(true);
		expect(result.details.backend).toBe("brave");
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("Brave result");
		expect(text).toContain("native search unavailable");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("persists oversized native failures together with fallback results without losing either", async () => {
		const reason = "upstream error ".repeat(5000) + "ERROR_TAIL";
		mocks.callApiStream.mockRejectedValue(new Error(reason));
		vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com", description: "Result snippet" }] } }), { headers: { "content-type": "application/json" } })));
		const result = await execute();
		expect(result.content[0].text).toContain("<persisted-output>");
		const saved = readFileSync(join(dir, "tool-results", "search-native.txt"), "utf8");
		expect(saved).toContain(reason);
		expect(saved).toContain("Brave result");
	});

	it.each([
		{ text: "Plausible answer from memory", nativeSearchUsed: false },
		{ text: "No answer available.", nativeSearchUsed: false },
		{ text: "", nativeSearchUsed: true },
		{ text: "No answer available.", nativeSearchUsed: true },
		{ text: "Search unavailable; here's what I remember.", nativeSearchUsed: true, searchResults: [{ type: "web_search_tool_result_error", status: "rate_limit_error" }] },
		{ text: "", nativeSearchUsed: true, sources: [{ title: "Example", url: "https://example.com" }] },
		{ text: "No answer available.", nativeSearchUsed: true, sources: [{ title: "Example", url: "https://example.com" }] },
	])("does not pass an unsearched or empty response off as a search result: $text", async (response) => {
		mocks.callApiStream.mockResolvedValue(response);
		vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com", description: "Result snippet" }] } }), { headers: { "content-type": "application/json" } })));
		const result = await execute();
		expect(result.details.backend).toBe("brave");
		expect(result.content.map((block) => block.text).join("\n")).toContain("Provider-native search");
	});

	it("bounds a stalled native transport and reports the timeout before fallback", async () => {
		vi.useFakeTimers();
		let nativeSignal: AbortSignal | undefined;
		mocks.callApiStream.mockImplementation(async (_ctx, _model, _body, _onUpdate, signal) => {
			nativeSignal = signal;
			return new Promise(() => {});
		});
		vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
		const fetch = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }), { headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetch);
		const pending = execute();
		await vi.advanceTimersByTimeAsync(120_001);
		expect(nativeSignal?.aborted).toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		const result = await pending;
		expect(result.details.backend).toBe("brave");
		expect(result.content.map((block) => block.text).join("\n")).toContain("within 120 seconds");
	});

	it("does not fall back after native search cancellation", async () => {
		const controller = new AbortController();
		mocks.callApiStream.mockImplementation(async () => {
			controller.abort();
			throw new Error("cancelled");
		});
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const result = await execute(controller.signal);
		expect(result.isError).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
});

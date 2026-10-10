import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webExtension from "../../extensions/web/index.ts";
import { NATIVE_SEARCH_TIMEOUT_MS } from "../../extensions/web/native-call.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let dir: string;
const model = { provider: "google", api: "google-generative-ai", id: "gemini-test", baseUrl: "https://google.example.test/v1", maxTokens: 8192 };
type Result = { content: Array<{ text: string }>; details: { backend?: string }; isError?: boolean };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-search-transport-"));
	vi.stubEnv("PI_WEB_SEARCH_CONFIG", join(dir, "missing-config.json"));
	vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-test-key");
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

async function execute(selectedModel = model): Promise<Result> {
	const fake = createFakePi();
	webExtension(fake.pi as never);
	return await fake.tools.get("web_search")!.execute("search-real-transport", { query: "test search" }, undefined, undefined, createFakeCtx({
		model: selectedModel,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "google-test-key" }) },
		sessionManager: { getSessionDir: () => dir },
	})) as Result;
}

const braveReply = () => new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com/source", description: "Fresh result" }] } }), { headers: { "content-type": "application/json" } });

describe("web_search through the real pi-web-search transport", () => {
	it("sends the native search tool and persists all of a streamed large answer", async () => {
		const answer = "answer text ".repeat(6000) + "TAIL_SENTINEL";
		const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ candidates: [{
			content: { parts: [{ text: answer }] },
			finishReason: "STOP",
			groundingMetadata: { webSearchQueries: ["test search"], groundingChunks: [{ web: { title: "Example", uri: "https://example.com/source" } }] },
		}] })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetch);
		const result = await execute();
		expect(result.details.backend).toBe("google/gemini-test");
		expect(result.content[0].text).toContain("<persisted-output>");
		const saved = readFileSync(join(dir, "tool-results", "search-real-transport.txt"), "utf8");
		expect(saved).toContain(answer);
		expect(saved).toContain("https://example.com/source");
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://google.example.test/v1/models/gemini-test:streamGenerateContent?alt=sse");
		expect(init.headers).toMatchObject({ "x-goog-api-key": "google-test-key" });
		expect(JSON.parse(init.body as string).tools).toEqual([{ google_search: {} }]);
	});

	it("preserves OpenAI Responses search tools, sources and labels", async () => {
		const events = [
			{ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "test search", sources: [{ title: "Example", url: "https://example.com/source" }] } } },
			{ type: "response.output_text.delta", delta: "The sourced answer." },
			{ type: "response.completed", response: { status: "completed" } },
		];
		const fetch = vi.fn(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetch);
		const result = await execute({ ...model, provider: "openai", api: "openai-responses", id: "gpt-test", baseUrl: "https://openai.example.test/v1" });
		expect(result.details.backend).toBe("openai/gpt-test");
		expect(result.content[0].text).toContain("The sourced answer.");
		expect(result.content[0].text).toContain("https://example.com/source");
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openai.example.test/v1/responses");
		expect(JSON.parse(init.body as string).tools).toEqual([{ type: "web_search" }]);
	});

	it("preserves Anthropic-compatible native search without taking the first-party route", async () => {
		const events = [
			{ type: "content_block_start", content_block: { type: "server_tool_use", name: "web_search", id: "ws_1", input: { query: "test search" } } },
			{ type: "content_block_start", content_block: { type: "web_search_tool_result", tool_use_id: "ws_1", content: [{ type: "web_search_result", title: "Example", url: "https://example.com/source" }] } },
			{ type: "content_block_delta", delta: { type: "text_delta", text: "The sourced answer." } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		];
		const fetch = vi.fn(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetch);
		const result = await execute({ ...model, provider: "anthropic-proxy", api: "anthropic-messages", id: "claude-test", baseUrl: "https://anthropic.example.test" });
		expect(result.details.backend).toBe("anthropic-proxy/claude-test");
		expect(result.content[0].text).toContain("The sourced answer.");
		expect(result.content[0].text).toContain("https://example.com/source");
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://anthropic.example.test/v1/messages");
		expect(JSON.parse(init.body as string).tools[0].type).toBe("web_search_20250305");
	});

	it("falls back when a successful native stream contains no search", async () => {
		const fetch = vi.fn(async (url: string) => url.startsWith("https://google.example.test/")
			? new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } })
			: braveReply());
		vi.stubGlobal("fetch", fetch);
		const result = await execute();
		expect(result.details.backend).toBe("brave");
		expect(result.content[0].text).toContain("without performing a web search");
		expect(result.content[0].text).not.toContain("No answer available.");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	const partialStreams = [
		{
			provider: "google",
			selectedModel: model,
			events: [{ candidates: [{ content: { parts: [{ text: "Partial answer from the source" }] }, groundingMetadata: { webSearchQueries: ["test search"], groundingChunks: [{ web: { title: "Example", uri: "https://example.com/source" } }] } }] }],
			error: { error: { code: 503, message: "upstream stream failed" } },
		},
		{
			provider: "openai",
			selectedModel: { ...model, provider: "openai", api: "openai-responses", id: "gpt-test", baseUrl: "https://openai.example.test/v1" },
			events: [
				{ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "test search", sources: [{ title: "Example", url: "https://example.com/source" }] } } },
				{ type: "response.output_text.delta", delta: "Partial answer from the source" },
			],
			error: { type: "response.failed", response: { error: { message: "upstream stream failed" } } },
		},
		{
			provider: "anthropic",
			selectedModel: { ...model, provider: "anthropic-proxy", api: "anthropic-messages", id: "claude-test", baseUrl: "https://anthropic.example.test" },
			events: [
				{ type: "content_block_start", content_block: { type: "server_tool_use", name: "web_search", id: "ws_1", input: { query: "test search" } } },
				{ type: "content_block_start", content_block: { type: "web_search_tool_result", tool_use_id: "ws_1", content: [{ type: "web_search_result", title: "Example", url: "https://example.com/source" }] } },
				{ type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer from the source" } },
			],
			error: { type: "error", error: { type: "overloaded_error", message: "upstream stream failed" } },
		},
	];

	// Known upstream gap: callApiStream drops terminal-state metadata. Keep the
	// desired contract executable until the vendor exposes enough state to enforce it.
	it.fails.each(partialStreams)("does not accept a $provider stream that closes before its terminal event", async ({ selectedModel, events }) => {
		const fetch = vi.fn(async (url: string) => url.startsWith("https://api.search.brave.com/")
			? braveReply()
			: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetch);
		const result = await execute(selectedModel);
		expect(result.details.backend).toBe("brave");
		expect(result.content[0].text).not.toContain("Partial answer from the source");
	});

	it.each(partialStreams)("falls back on an explicit $provider stream error after text and sources", async ({ selectedModel, events, error }) => {
		const fetch = vi.fn(async (url: string) => url.startsWith("https://api.search.brave.com/")
			? braveReply()
			: new Response([...events, error].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
		vi.stubGlobal("fetch", fetch);
		const result = await execute(selectedModel);
		expect(result.details.backend).toBe("brave");
		expect(result.content[0].text).toContain("upstream stream failed");
		expect(result.content[0].text).not.toContain("Partial answer from the source");
	});

	it("reports a failed Anthropic search even when an earlier search supplied sources", async () => {
		const native = partialStreams[2];
		const events = [...native.events,
			{ type: "content_block_start", content_block: { type: "web_search_tool_result", tool_use_id: "ws_2", content: { type: "web_search_tool_result_error", error_code: "rate_limit_error" } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		];
		vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("https://api.search.brave.com/")
			? braveReply()
			: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })));
		const result = await execute(native.selectedModel);
		expect(result.details.backend).toBe("brave");
		expect(result.content[0].text).toContain("rate_limit_error");
		expect(result.content[0].text).not.toContain("Partial answer from the source");
	});

	it("aborts a stalled SSE body at the deadline and continues the search chain", async () => {
		vi.useFakeTimers();
		let nativeSignal: AbortSignal | undefined;
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.startsWith("https://google.example.test/")) return braveReply();
			nativeSignal = init?.signal ?? undefined;
			return new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
					nativeSignal?.addEventListener("abort", () => controller.error(nativeSignal?.reason), { once: true });
				},
			}), { headers: { "content-type": "text/event-stream" } });
		});
		vi.stubGlobal("fetch", fetch);
		const pending = execute();
		await vi.advanceTimersByTimeAsync(NATIVE_SEARCH_TIMEOUT_MS + 1);
		expect(nativeSignal?.aborted).toBe(true);
		const result = await pending;
		expect(result.details.backend).toBe("brave");
		expect(result.content[0].text).toContain("within 120 seconds");
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

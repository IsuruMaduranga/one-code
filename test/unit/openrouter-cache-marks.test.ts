import { describe, expect, it } from "vitest";
import { getModels } from "@earendil-works/pi-ai/compat";
import { openRouterCacheMarksProvider, takesOpenRouterCacheMarks, withOpenRouterCacheMarks } from "../../extensions/lib/request/openrouter-cache-marks.ts";
import { openRouterCacheMarksRegistration } from "../../extensions/lib/request/anthropic-stream.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, api: "openai-completions", provider: "openrouter", compat: { thinkingFormat: "openrouter" }, ...extra });

describe("takesOpenRouterCacheMarks", () => {
	it("marks OpenRouter's open-weight Chat Completions models", () => {
		for (const id of ["qwen/qwen3.8-27b", "qwen/qwen3.7-flash", "deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3", "moonshotai/kimi-k3", "minimax/minimax-m3", "~moonshotai/kimi-latest", "rekaai/reka-flash-3"]) {
			expect(takesOpenRouterCacheMarks(model(id)), id).toBe(true);
		}
	});

	it("leaves Anthropic, Google, OpenAI and OpenRouter's routers at pi's default", () => {
		for (const id of ["anthropic/claude-haiku-4.5:batch", "google/gemini-3.8-flash", "~google/gemini-flash-latest", "openai/gpt-6-luna", "openai/gpt-oss-120b", "~openai/gpt-latest", "openrouter/auto"]) {
			expect(takesOpenRouterCacheMarks(model(id)), id).toBe(false);
		}
	});

	it("keeps a format the catalog or the user already set", () => {
		expect(takesOpenRouterCacheMarks(model("qwen/qwen3.8-27b", { compat: { cacheControlFormat: "anthropic" } }))).toBe(false);
	});

	it("touches no other provider or API", () => {
		expect(takesOpenRouterCacheMarks(model("qwen/qwen3.8-27b", { provider: "alibaba" }))).toBe(false);
		expect(takesOpenRouterCacheMarks(model("qwen/qwen3.8-27b", { api: "anthropic-messages" }))).toBe(false);
	});
});

describe("withOpenRouterCacheMarks", () => {
	it("copies the model with Anthropic-style breakpoints on, without touching the original", () => {
		const original = model("qwen/qwen3.8-27b");
		const copy = withOpenRouterCacheMarks(original);
		expect(copy).not.toBe(original);
		expect(copy.compat).toEqual({ thinkingFormat: "openrouter", cacheControlFormat: "anthropic" });
		expect(original.compat).toEqual({ thinkingFormat: "openrouter" });
		expect(withOpenRouterCacheMarks<{ id: string; api: string; provider: string; compat?: unknown }>({ id: "qwen/qwen3.8-27b", api: "openai-completions", provider: "openrouter" }).compat).toEqual({ cacheControlFormat: "anthropic" });
	});

	it("returns a model it leaves alone as itself", () => {
		const gemini = model("google/gemini-3.8-flash");
		expect(withOpenRouterCacheMarks(gemini)).toBe(gemini);
	});
});

describe("openRouterCacheMarksProvider", () => {
	it("registers for openai-completions and hands the stream the marked model with the context and options unchanged", () => {
		const calls: unknown[][] = [];
		const config = openRouterCacheMarksProvider((m: { id: string; api: string; provider: string; compat?: unknown }, context: string, options?: { sessionId: string }) => {
			calls.push([m, context, options]);
			return "stream";
		});
		expect(config.api).toBe("openai-completions");
		expect(config.streamSimple(model("qwen/qwen3.8-27b"), "ctx", { sessionId: "s" })).toBe("stream");
		expect(calls).toEqual([[{ ...model("qwen/qwen3.8-27b"), compat: { thinkingFormat: "openrouter", cacheControlFormat: "anthropic" } }, "ctx", { sessionId: "s" }]]);
	});
});

describe("against pi-ai", () => {
	it("pi-ai has the Chat Completions implementation the registration wraps", () => {
		expect(openRouterCacheMarksRegistration()?.api).toBe("openai-completions");
	});

	it("the catalog still leaves the open-weight models unmarked, so the registration is what marks them", () => {
		const openRouter = getModels("openrouter");
		const qwen = openRouter.find((m) => m.id === "qwen/qwen3.8-27b");
		expect(qwen?.api).toBe("openai-completions");
		expect(takesOpenRouterCacheMarks(qwen!)).toBe(true);
		// Every Chat Completions model the catalog already marks is an Anthropic one, which this leaves alone.
		const marked = openRouter.filter((m) => (m.compat as { cacheControlFormat?: string } | undefined)?.cacheControlFormat === "anthropic");
		expect(marked.length).toBeGreaterThan(0);
		expect(marked.every((m) => m.id.startsWith("anthropic/"))).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { CACHE_DEFEATING_HOSTS, hostsFor, openRouterIgnoreHostsEnabled, withIgnoredHosts, withOpenRouterIgnoredHosts } from "../../extensions/lib/request/openrouter-ignored-hosts.ts";
import { withOpenRouterCacheMarks } from "../../extensions/lib/request/openrouter-cache-marks.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";

const model = (id: string, compat: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, api: "openai-completions", provider: "openrouter", compat, ...extra });

describe("CACHE_DEFEATING_HOSTS", () => {
	it("lists OpenInference by its OpenRouter slug, with the date it was measured and its measured scope", () => {
		expect(CACHE_DEFEATING_HOSTS).toEqual([{ slug: "open-inference", name: "OpenInference", measured: "2026-11-16", vendors: ["deepseek"] }]);
	});

	it("scopes a host to its vendors", () => {
		expect(hostsFor("deepseek/deepseek-v4.1-flash-1017").map((h) => h.slug)).toEqual(["open-inference"]);
		expect(hostsFor("~deepseek/deepseek-latest").map((h) => h.slug)).toEqual(["open-inference"]);
		for (const id of ["qwen/qwen3.8-27b", "z-ai/glm-5.3-flash", "anthropic/claude-haiku-4.5:batch", "deepseekish/model"]) expect(hostsFor(id), id).toEqual([]);
	});
});

describe("withIgnoredHosts", () => {
	it("adds the hosts when there is no routing", () => {
		expect(withIgnoredHosts(undefined)).toEqual({ ignore: ["open-inference"] });
		expect(withIgnoredHosts({})).toEqual({ ignore: ["open-inference"] });
	});

	it("appends to the user's ignore list and keeps every other field", () => {
		expect(withIgnoredHosts({ ignore: ["deepinfra"], sort: "price", allow_fallbacks: true })).toEqual({ ignore: ["deepinfra", "open-inference"], sort: "price", allow_fallbacks: true });
	});

	it("leaves a host the user names in order, only or ignore alone, by slug, variant or name", () => {
		for (const routing of [{ order: ["open-inference"] }, { only: ["OpenInference"] }, { order: ["wafer", "open-inference/fp4"] }, { ignore: ["Open-Inference"] }]) {
			expect(withIgnoredHosts(routing), JSON.stringify(routing)).toBe(routing);
		}
	});

	it("adds the host beside an order or only list that does not name it", () => {
		expect(withIgnoredHosts({ order: ["wafer"], allow_fallbacks: false })).toEqual({ order: ["wafer"], allow_fallbacks: false, ignore: ["open-inference"] });
		expect(withIgnoredHosts({ only: ["wafer", "modal"] })).toEqual({ only: ["wafer", "modal"], ignore: ["open-inference"] });
	});
});

describe("withOpenRouterIgnoredHosts", () => {
	it("sets the routing on an OpenRouter Chat Completions model in a host's scope, without touching the original", () => {
		for (const id of ["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro-0813"]) {
			const original = model(id, { thinkingFormat: "openrouter" });
			const copy = withOpenRouterIgnoredHosts(original);
			expect(copy.compat, id).toEqual({ thinkingFormat: "openrouter", openRouterRouting: { ignore: ["open-inference"] } });
			expect(original.compat).toEqual({ thinkingFormat: "openrouter" });
		}
	});

	it("leaves a model outside every scope alone, the user's routing included", () => {
		for (const id of ["qwen/qwen3.8-27b", "z-ai/glm-5.3-flash", "x-ai/grok-5", "google/gemini-3.8-flash", "openai/gpt-oss-120b", "anthropic/claude-haiku-4.5:batch"]) {
			const original = model(id, { openRouterRouting: { ignore: ["morph"] } });
			expect(withOpenRouterIgnoredHosts(original), id).toBe(original);
		}
	});

	it("merges with the routing a user's models.json put on the model", () => {
		expect(withOpenRouterIgnoredHosts(model("deepseek/deepseek-v4.1-flash", { openRouterRouting: { ignore: ["morph"] } })).compat).toEqual({ openRouterRouting: { ignore: ["morph", "open-inference"] } });
		const pinned = model("deepseek/deepseek-v4.1-flash", { openRouterRouting: { order: ["open-inference"], allow_fallbacks: false } });
		expect(withOpenRouterIgnoredHosts(pinned)).toBe(pinned);
	});

	it("touches no other provider or API", () => {
		const anthropic = model("anthropic/claude-haiku-4.5", {}, { api: "anthropic-messages" });
		expect(withOpenRouterIgnoredHosts(anthropic)).toBe(anthropic);
		const other = model("deepseek-v4.1-flash", {}, { provider: "deepseek" });
		expect(withOpenRouterIgnoredHosts(other)).toBe(other);
	});

	it("composes with the cache marks in either order to the same model", () => {
		const m = model("deepseek/deepseek-v4.1-flash", { thinkingFormat: "openrouter" });
		expect(withOpenRouterIgnoredHosts(withOpenRouterCacheMarks(m))).toEqual(withOpenRouterCacheMarks(withOpenRouterIgnoredHosts(m)));
		expect(withOpenRouterIgnoredHosts(withOpenRouterCacheMarks(m)).compat).toEqual({ thinkingFormat: "openrouter", cacheControlFormat: "anthropic", openRouterRouting: { ignore: ["open-inference"] } });
	});
});

describe("openRouterIgnoreHostsEnabled", () => {
	it("is off by default, so no host is left out unless the user asks, and on only with its own switch at 1", () => {
		const own = envName("OPENROUTER_IGNORE_HOSTS");
		expect(openRouterIgnoreHostsEnabled({})).toBe(false);
		expect(openRouterIgnoreHostsEnabled({ [own]: "0" })).toBe(false);
		expect(openRouterIgnoreHostsEnabled({ [envName("CACHE_MARKS")]: "1" })).toBe(false);
		expect(openRouterIgnoreHostsEnabled({ [own]: "1" })).toBe(true);
	});
});

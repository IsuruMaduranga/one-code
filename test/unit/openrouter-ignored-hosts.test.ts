import { describe, expect, it } from "vitest";
import { CACHE_DEFEATING_HOSTS, openRouterIgnoreHostsEnabled, withIgnoredHosts, withOpenRouterIgnoredHosts } from "../../extensions/lib/request/openrouter-ignored-hosts.ts";
import { withOpenRouterCacheMarks } from "../../extensions/lib/request/openrouter-cache-marks.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";

const model = (id: string, compat: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, api: "openai-completions", provider: "openrouter", compat, ...extra });

describe("CACHE_DEFEATING_HOSTS", () => {
	it("lists OpenInference by its OpenRouter slug, with the date it was measured", () => {
		expect(CACHE_DEFEATING_HOSTS).toEqual([{ slug: "open-inference", name: "OpenInference", measured: "2026-11-16" }]);
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
	it("sets the routing on every OpenRouter Chat Completions model, whatever the vendor, without touching the original", () => {
		for (const id of ["deepseek/deepseek-v4.1-flash-1017", "qwen/qwen3.8-27b", "x-ai/grok-5", "google/gemini-3.8-flash", "openai/gpt-oss-120b", "anthropic/claude-haiku-4.5:batch"]) {
			const original = model(id, { thinkingFormat: "openrouter" });
			const copy = withOpenRouterIgnoredHosts(original);
			expect(copy.compat, id).toEqual({ thinkingFormat: "openrouter", openRouterRouting: { ignore: ["open-inference"] } });
			expect(original.compat).toEqual({ thinkingFormat: "openrouter" });
		}
	});

	it("merges with the routing a user's models.json put on the model", () => {
		expect(withOpenRouterIgnoredHosts(model("z-ai/glm-5.3", { openRouterRouting: { ignore: ["morph"] } })).compat).toEqual({ openRouterRouting: { ignore: ["morph", "open-inference"] } });
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
	it("is on by default and off only with its own switch at 0", () => {
		const own = envName("OPENROUTER_IGNORE_HOSTS");
		expect(openRouterIgnoreHostsEnabled({})).toBe(true);
		expect(openRouterIgnoreHostsEnabled({ [own]: "1" })).toBe(true);
		expect(openRouterIgnoreHostsEnabled({ [envName("CACHE_MARKS")]: "0" })).toBe(true);
		expect(openRouterIgnoreHostsEnabled({ [own]: "0" })).toBe(false);
	});
});

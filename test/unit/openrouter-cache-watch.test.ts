import { describe, expect, it } from "vitest";
import { cacheMissNotice, createCacheWatch, MISS_STREAK, type ReplyCache } from "../../extensions/lib/request/openrouter-cache-watch.ts";

const reply = (prompt: number, cacheRead: number, host = "Cold Host", model = "openrouter/qwen/qwen3.8-27b"): ReplyCache => ({ model, host, input: prompt - cacheRead, cacheRead, cacheWrite: 0 });

describe("openrouter cache watch", () => {
	it("names a host after three misses in a row, once", () => {
		const watch = createCacheWatch();
		expect(watch.observe(reply(20_000, 0))).toBeUndefined();
		expect(watch.observe(reply(21_000, 0))).toBeUndefined();
		expect(watch.observe(reply(22_000, 0))).toBeUndefined();
		const streak = watch.observe(reply(23_000, 0));
		expect(streak).toEqual({ model: "openrouter/qwen/qwen3.8-27b", host: "Cold Host", misses: MISS_STREAK, missedTokens: 20_000 + 21_000 + 22_000 });
		expect(watch.observe(reply(24_000, 0))).toBeUndefined();
	});

	it("stays quiet on rounding, on one miss now and then, and across a host or model change", () => {
		const watch = createCacheWatch();
		// About a thousand tokens short each time: a host's rounding.
		for (let prompt = 27_000; prompt < 40_000; prompt += 1_000) expect(watch.observe(reply(prompt, prompt - 2_000, "Alibaba"))).toBeUndefined();
		// A rebuilt prompt misses once, then the cache reads again.
		const mixed = createCacheWatch();
		for (const [prompt, read] of [[20_000, 0], [21_000, 0], [22_000, 0], [23_000, 21_900], [24_000, 0], [25_000, 0]] as const) expect(mixed.observe(reply(prompt, read))).toBeUndefined();
		// A new host or model starts over.
		const moved = createCacheWatch();
		expect(moved.observe(reply(20_000, 0, "A"))).toBeUndefined();
		expect(moved.observe(reply(21_000, 0, "A"))).toBeUndefined();
		expect(moved.observe(reply(22_000, 0, "B"))).toBeUndefined();
		expect(moved.observe(reply(23_000, 0, "B", "openrouter/deepseek/deepseek-v4.1-flash"))).toBeUndefined();
	});

	it("does not count a shrinking prompt's removed tokens as misses", () => {
		const watch = createCacheWatch();
		for (const prompt of [100_000, 10_000, 7_000, 4_000]) expect(watch.observe(reply(prompt, prompt))).toBeUndefined();
	});

	it("says what the misses cost and how to skip the host", () => {
		const notice = cacheMissNotice({ model: "openrouter/qwen/qwen3.8-27b", host: "Cold Host", misses: 3, missedTokens: 63_000 }, 0.2);
		expect(notice).toBe(
			"OpenRouter's host Cold Host missed the prompt cache on the last 3 replies of openrouter/qwen/qwen3.8-27b (63,000 tokens sent again at the full input price, about $0.01 more). To skip it, add Cold Host to the ignored providers in your OpenRouter account settings, or ignore it for this model with compat.openRouterRouting in pi's models.json.",
		);
		expect(cacheMissNotice({ model: "m", host: "H", misses: 3, missedTokens: 20_000 }, 0.2)).toContain("about $0.0040 more");
		expect(cacheMissNotice({ model: "m", host: "H", misses: 3, missedTokens: 5_000 })).not.toContain("$");
	});
});

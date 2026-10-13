import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifierCandidates, describeCandidate, isModelUnavailableError } from "../../extensions/auto-mode/model-select.ts";
import { CLASSIFIER_CALL_TOKENS, classifierCallCost } from "../../extensions/lib/model-policy.ts";
import { intrinsicTier } from "../../extensions/lib/model-tier.ts";
import { type FixtureModel, pinCatalog } from "./catalog-fixture.ts";

/** Minimal structural stand-in; selection consults provider/id/cost/contextWindow. */
const model = (provider: string, id: string, input?: number, contextWindow?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 }, ...(contextWindow === undefined ? {} : { contextWindow }) }) as any;

const pickFull = (available: any[], sessionModel: any) => classifierCandidates({ available, sessionModel });
/** An OpenRouter model with a full cost record (cache-read price optional) and a 1M window. */
const priced = (id: string, cost: { input: number; cacheRead?: number; output: number }) => ({ ...model("openrouter", id, cost.input, 1_000_000), cost }) as any;

/**
 * One release date, so nothing supersedes anything: large, medium and mid are
 * workhorse by price against the median, small is cheap, nano tiny by name.
 */
const LINEUP: FixtureModel[] = [
	{ id: "openai/gpt-x-large", released: "2026-09-01", price: [10, 40], servedAs: ["openrouter/openai/gpt-x-large"] },
	{ id: "openai/gpt-x-medium", released: "2026-09-01", price: [5, 20], servedAs: ["openrouter/openai/gpt-x-medium"] },
	{ id: "openai/gpt-x-mid", released: "2026-09-01", price: [4, 16] },
	{ id: "openai/gpt-x-small", released: "2026-09-01", price: [0.5, 2], servedAs: ["openrouter/openai/gpt-x-small"] },
	{ id: "openai/gpt-x-nano", released: "2026-09-01", price: [0.05, 0.2], servedAs: ["openrouter/openai/gpt-x-nano"] },
	{ id: "openai/gpt-x-medium-exp", released: "2026-09-01", price: [4.5, 18] },
];
const ANTHROPIC: FixtureModel[] = [
	{ id: "anthropic/claude-fable-5-1", released: "2026-09-01", price: [10, 50] },
	{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20], servedAs: ["openrouter/anthropic/claude-opus-5.5"] },
	{ id: "anthropic/claude-sonnet-5-5", released: "2026-09-28", price: [2, 10] },
	// Not in the model pairing table: the cost algorithm picks for it.
	{ id: "anthropic/claude-opus-4-9", released: "2026-09-22", price: [4, 20] },
	{ id: "anthropic/claude-sonnet-5", released: "2026-06-29", price: [2, 10] },
	{ id: "anthropic/claude-haiku-4-5", released: "2025-10-15", price: [1, 5] },
];
const QWEN: FixtureModel[] = [
	{ id: "alibaba/qwen3.8-max", released: "2026-09-02", price: [1.2, 6], servedAs: ["openrouter/qwen/qwen3.8-max"] },
	{ id: "alibaba/qwen3.8-2.4t-a95b", released: "2026-08-12", price: [1.2, 6], servedAs: ["openrouter/qwen/qwen3.8-2.4t-a95b"] },
	{ id: "alibaba/qwen3.8-plus", released: "2026-09-02", price: [0.8, 4] },
	{ id: "alibaba/qwen3.8-flash", released: "2026-08-26", price: [0.05, 0.4], servedAs: ["openrouter/qwen/qwen3.8-flash"] },
	{ id: "alibaba/qwen3.8-27b", released: "2026-08-14", price: [0.3, 2], params: 28e9, servedAs: ["openrouter/qwen/qwen3.8-27b"] },
	{ id: "alibaba/qwen3.6-flash", released: "2026-04-27", price: [0.07, 0.6], servedAs: ["openrouter/qwen/qwen3.6-flash"] },
];

beforeEach(() => pinCatalog([...LINEUP, ...ANTHROPIC, ...QWEN]));
afterEach(() => vi.unstubAllEnvs());

describe("classifierCandidates: containment, tier and context floors", () => {
	it("selects the cheapest same-route model in the session's tier that contains its context window", () => {
		const session = model("openai", "gpt-x-large", 10, 200_000);
		const medium = model("openai", "gpt-x-medium", 5, 200_000);
		const available = [session, medium, model("openai", "gpt-x-mid", 4, 100_000), model("openai", "gpt-x-small", 0.5, 400_000), model("openai", "gpt-x-nano", 0.05, 400_000)];
		const result = pickFull(available, session);
		// Mid is cheaper but cannot contain the window; small is a lower tier; nano is tiny.
		expect(result.candidates).toEqual([{ model: medium, source: "economical" }, { model: session, source: "session" }]);
		expect(result.fallback).toBeUndefined();
	});

	it("never leaves the session provider or gateway route", () => {
		const session = model("openrouter", "openai/gpt-x-large", 10, 200_000);
		const available = [session, model("openrouter", "openai/gpt-x-medium", 5, 200_000), model("openrouter", "anthropic/claude-opus-5.5", 1, 1_000_000)];
		const result = pickFull(available, session);
		expect(result.candidates[0].model.id).toBe("openai/gpt-x-medium");
		for (const candidate of result.candidates) expect(candidate.model.id.startsWith("openai/")).toBe(true);
	});

	it("makes an unknown candidate context window ineligible", () => {
		const session = model("anthropic", "claude-fable-5-1", 10, 200_000);
		const unknownWindow = model("anthropic", "claude-sonnet-5-5", 2);
		const qualifying = model("anthropic", "claude-opus-5-5", 4, 200_000);
		const result = pickFull([session, unknownWindow, qualifying], session);
		expect(result.candidates[0].model).toBe(qualifying);
		expect(result.candidates.map((candidate) => candidate.model)).not.toContain(unknownWindow);
	});

	it("uses the session itself when its catalog context window is unknown", () => {
		const session = model("anthropic", "claude-opus-5-5", 4);
		const result = pickFull([session, model("anthropic", "claude-sonnet-5-5", 2, 1_000_000)], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "unknown-session-context-window" });
		expect(result.notices).toContainEqual(expect.objectContaining({ fallbackReason: "unknown-session-context-window" }));
	});

	it("uses the session itself with a reason when nothing qualifies", () => {
		const session = model("openai", "gpt-x-large", 10, 1_000_000);
		const result = pickFull([session, model("openai", "gpt-x-medium", 5, 200_000)], session);
		expect(result.candidates[0]).toEqual({ model: session, source: "session" });
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
		expect(result.fallback?.text).toContain("in its workhorse tier or above contains its 1000000-token catalog context window");
	});

	it("never screens with a model in a lower tier, however much cheaper", () => {
		const session = model("openai", "gpt-x-medium", 5, 200_000);
		const small = model("openai", "gpt-x-small", 0.5, 200_000);
		expect(intrinsicTier(small)).toBe("cheap");
		expect(pickFull([session, small], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("screens a frontier session the table names with its pairing, the cost algorithm's picks behind it, the session last", () => {
		const opus = model("anthropic", "claude-opus-5-5", 4, 200_000);
		const sonnet = model("anthropic", "claude-sonnet-5-5", 2, 200_000);
		const haiku = model("anthropic", "claude-haiku-4-5", 1, 200_000);
		expect(pickFull([opus, sonnet, haiku], opus).candidates).toEqual([{ model: sonnet, source: "paired" }, { model: opus, source: "session" }]);
		const fable = model("anthropic", "claude-fable-5-1", 10, 200_000);
		// Opus 5.5 stays as a backup, in case the provider refuses Sonnet 5.5 to this account.
		expect(pickFull([fable, opus, sonnet, haiku], fable).candidates).toEqual([
			{ model: sonnet, source: "paired" },
			{ model: opus, source: "economical" },
			{ model: fable, source: "session" },
		]);
	});

	it("screens a frontier session the table does not name with the cheapest frontier model, never a lower tier", () => {
		const opus = model("anthropic", "claude-opus-4-9", 4, 200_000);
		const sonnet = model("anthropic", "claude-sonnet-5-5", 2, 200_000);
		const haiku = model("anthropic", "claude-haiku-4-5", 1, 200_000);
		expect(pickFull([opus, sonnet, haiku], opus).candidates).toEqual([{ model: sonnet, source: "economical" }, { model: opus, source: "session" }]);
	});

	it("screens a tiny session with a cheaper model of a higher tier, never a dearer one", () => {
		// Qwen 3.8 27B once drew the 2.4T model at five times its input price.
		const session = model("openrouter", "qwen/qwen3.8-27b", 0.3, 1_000_000);
		const huge = model("openrouter", "qwen/qwen3.8-2.4t-a95b", 1.2, 1_000_000);
		const flash = model("openrouter", "qwen/qwen3.8-flash", 0.05, 1_000_000);
		expect(intrinsicTier(session)).toBe("tiny");
		expect(pickFull([session, huge], session).candidates).toEqual([{ model: session, source: "session" }]);
		expect(pickFull([session, huge, flash], session).candidates).toEqual([{ model: flash, source: "economical" }, { model: session, source: "session" }]);
	});

	// A classifier call is mostly cached input, so a model dearer by list input
	// price can be the cheaper screener (DeepSeek V3.2 against V4.1 Flash).
	it("judges cheaper per classifier call, where cache reads dominate", () => {
		const session = priced("qwen/qwen3.8-27b", { input: 0.3, cacheRead: 0.3, output: 1.2 }); // a cache read at no discount
		const cachedMax = priced("qwen/qwen3.8-max", { input: 1.2, cacheRead: 0.03, output: 6 });
		expect(classifierCallCost(cachedMax)!).toBeLessThan(classifierCallCost(session)!);
		expect(pickFull([session, cachedMax], session).candidates).toEqual([{ model: cachedMax, source: "economical" }, { model: session, source: "session" }]);
		// Without a cheap cache read the same list prices stay dearer per call.
		const uncachedMax = priced("qwen/qwen3.8-max", { input: 1.2, output: 6 });
		expect(pickFull([session, uncachedMax], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	// A session whose catalog lists no cache-read price would be overstated per
	// call, so a dearer model could win; it is compared by list input price.
	it("compares by list input price when the session has no cache-read price", () => {
		const session = priced("qwen/qwen3.8-27b", { input: 0.3, output: 1.2 });
		const cachedMax = priced("qwen/qwen3.8-max", { input: 1.2, cacheRead: 0.06, output: 6 });
		expect(pickFull([session, cachedMax], session).candidates).toEqual([{ model: session, source: "session" }]);
		const flash = priced("qwen/qwen3.8-flash", { input: 0.05, cacheRead: 0.01, output: 0.4 });
		expect(pickFull([session, cachedMax, flash], session).candidates).toEqual([{ model: flash, source: "economical" }, { model: session, source: "session" }]);
	});

	it("prices a call at the measured shape, overstating a missing cache-read or output price", () => {
		const { cachedInput, freshInput, output } = CLASSIFIER_CALL_TOKENS;
		const full = { ...model("openai", "gpt-x-small", 1), cost: { input: 1, cacheRead: 0.1, output: 4 } } as any;
		expect(classifierCallCost(full)).toBeCloseTo((0.1 * cachedInput + 1 * freshInput + 4 * output) / 1e6, 12);
		const bare = { ...model("openai", "gpt-x-small", 1), cost: { input: 1 } } as any;
		expect(classifierCallCost(bare)).toBeCloseTo((cachedInput + freshInput + output) / 1e6, 12);
		expect(classifierCallCost(model("openai", "gpt-x-small"))).toBeUndefined();
	});

	it("never screens with a superseded or uncatalogued model", () => {
		const session = model("openrouter", "qwen/qwen3.8-flash", 0.05, 1_000_000);
		const older = model("openrouter", "qwen/qwen3.6-flash", 0.04, 1_000_000); // superseded by 3.8 Flash
		const unknown = model("openrouter", "qwen/qwen3.9-mystery", 0.01, 1_000_000);
		expect(pickFull([session, older, unknown], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("never screens with an experimental build", () => {
		const session = model("openai", "gpt-x-large", 10, 200_000);
		const experimental = model("openai", "gpt-x-medium-exp", 4.5, 200_000);
		expect(intrinsicTier(experimental)).toBe("workhorse");
		expect(pickFull([session, experimental], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("never screens with a moving -latest alias", () => {
		pinCatalog([...LINEUP, ...ANTHROPIC, ...QWEN, { id: "openai/gpt-x-latest", released: "2026-09-01", price: [4.5, 18] }]);
		const session = model("openai", "gpt-x-large", 10, 200_000);
		const alias = model("openai", "gpt-x-latest", 4.5, 200_000);
		expect(intrinsicTier(alias)).toBe("workhorse");
		expect(pickFull([session, alias], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("screens with the session unless an alternate is strictly cheaper", () => {
		// A dearer model never screens; a same-price one saves nothing, so the
		// session keeps the job (the GPT-6 Sol case: GPT-5.6 Sol at the same $2).
		const session = model("openai", "gpt-x-medium", 5, 200_000);
		expect(pickFull([session, model("openai", "gpt-x-large", 10, 200_000)], session).candidates).toEqual([{ model: session, source: "session" }]);
		const samePrice = model("openai", "gpt-x-mid", 5, 200_000);
		expect(pickFull([session, samePrice], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("keeps an unpriced session on its own model", () => {
		const session = model("openai", "gpt-x-large", undefined, 200_000);
		expect(pickFull([session, model("openai", "gpt-x-medium", 5, 200_000)], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("ignores a prompt-tier override and retains an unlisted session model", () => {
		vi.stubEnv("CC_PROMPT_TIER", "tiny");
		const session = model("openai", "gpt-x-large", 10, 200_000);
		const medium = model("openai", "gpt-x-medium", 5, 200_000);
		expect(pickFull([medium], session).candidates).toEqual([{ model: medium, source: "economical" }, { model: session, source: "session" }]);
	});
});

describe("classifierCandidates: Haiku 5 has the frontier prompt, not an Opus-class place", () => {
	const haiku55: FixtureModel = { id: "anthropic/claude-haiku-5-5", released: "2026-10-07", price: [0.1, 0.5] };
	const opus46: FixtureModel = { id: "anthropic/claude-opus-4-6", released: "2026-02-05", price: [5, 25] };

	it("never hands an Opus session the table does not name, or one it steps aside for, to Haiku 5.5", () => {
		const sonnet6: FixtureModel = { id: "anthropic/claude-sonnet-6", released: "2026-12-01", price: [2, 10] };
		pinCatalog([...ANTHROPIC, haiku55, opus46, sonnet6]);
		const haiku = model("anthropic", "claude-haiku-5-5", 0.1, 1_000_000);
		const sonnet = model("anthropic", "claude-sonnet-5-5", 2, 1_000_000);
		const opus4 = model("anthropic", "claude-opus-4-6", 5, 1_000_000);
		expect(pickFull([opus4, sonnet, haiku], opus4).candidates[0].model.id).toBe("claude-sonnet-5-5");
		// A newer Anthropic model switches the table off; the cost algorithm still skips Haiku.
		const opus = model("anthropic", "claude-opus-5-5", 4, 1_000_000);
		const sonnet6Model = model("anthropic", "claude-sonnet-6", 2, 1_000_000);
		const chain = pickFull([opus, sonnet, sonnet6Model, haiku], opus).candidates.map((c: { model: { id: string } }) => c.model.id);
		expect(chain).not.toContain("claude-haiku-5-5");
		expect(intrinsicTier(haiku)).not.toBe("frontier");
	});
});

describe("classifierCandidates: cost and variants", () => {
	it("does not auto-select tiny, unpriced, or unsuitable variants", () => {
		const session = model("openrouter", "openai/gpt-x-large", 10, 200_000);
		const available = [
			session,
			model("openrouter", "openai/gpt-x-small", 0.5, 200_000),
			model("openrouter", "openai/gpt-x-nano", 0.05, 200_000),
			model("openrouter", "openai/gpt-x-medium:batch", 0.01, 200_000),
			model("openrouter", "openai/gpt-x-medium", undefined, 200_000),
		];
		expect(pickFull(available, session).candidates).toEqual([{ model: session, source: "session" }]);
	});
});

describe("isModelUnavailableError", () => {
	it("recognises permanent model failures but not transient or request-shape failures", () => {
		for (const message of ["404 model not found", "403 Forbidden", "401 unauthorized", "you do not have access to this model", "insufficient_quota", "invalid_model", "The model is not supported when using Codex with a ChatGPT account."]) {
			expect(isModelUnavailableError(message), message).toBe(true);
		}
		for (const message of ["socket hang up", "500 internal server error", "ETIMEDOUT", "quota exceeded, retry in 60s", "response_format is not supported for this model"]) {
			expect(isModelUnavailableError(message), message).toBe(false);
		}
	});
});

describe("describeCandidate", () => {
	it("includes automatic selection or session fallback metadata", () => {
		expect(describeCandidate({ model: model("openai", "gpt-5-mini", 0.25, 200_000), source: "economical" })).toContain("cheapest model within");
		expect(describeCandidate({ model: model("groq", "llama-3.3-70b-versatile", 0.6, 200_000), source: "session" })).toContain("this session's model");
	});
});

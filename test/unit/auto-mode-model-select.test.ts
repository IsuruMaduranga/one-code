import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifierCandidates, describeCandidate, isModelUnavailableError } from "../../extensions/auto-mode/model-select.ts";
import { intrinsicTier } from "../../extensions/lib/model-tier.ts";
import { type FixtureModel, pinCatalog } from "./catalog-fixture.ts";

/** Minimal structural stand-in; selection consults provider/id/cost/contextWindow. */
const model = (provider: string, id: string, input?: number, contextWindow?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 }, ...(contextWindow === undefined ? {} : { contextWindow }) }) as any;

const pickFull = (available: any[], sessionModel: any) => classifierCandidates({ available, sessionModel });

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

	it("screens a frontier session with the cheapest frontier model, never a lower tier", () => {
		const opus = model("anthropic", "claude-opus-5-5", 4, 200_000);
		const sonnet = model("anthropic", "claude-sonnet-5-5", 2, 200_000);
		const haiku = model("anthropic", "claude-haiku-4-5", 1, 200_000);
		expect(pickFull([opus, sonnet, haiku], opus).candidates).toEqual([{ model: sonnet, source: "economical" }, { model: opus, source: "session" }]);
		const fable = model("anthropic", "claude-fable-5-1", 10, 200_000);
		expect(pickFull([fable, opus, sonnet, haiku], fable).candidates.map((entry) => entry.model.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
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

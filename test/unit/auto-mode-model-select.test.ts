import { afterEach, describe, expect, it, vi } from "vitest";
import { classifierCandidates, describeCandidate, isModelUnavailableError } from "../../extensions/auto-mode/model-select.ts";
import { capabilityFloor, setCapabilitySnapshotForTest, slugCandidates, type CapabilitySnapshot } from "../../extensions/lib/capability-index.ts";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";
import { intrinsicTier } from "../../extensions/lib/model-tier.ts";

/** Minimal structural stand-in; selection consults provider/id/cost/contextWindow. */
const model = (provider: string, id: string, input?: number, contextWindow?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 }, ...(contextWindow === undefined ? {} : { contextWindow }) }) as any;

const pickFull = (available: any[], sessionModel: any) => classifierCandidates({ available, sessionModel });

/** Synthetic equal scores: tests of other gates must first establish capability. */
function measure(models: any[]): CapabilitySnapshot {
	const releaseDate = "2026-09-01";
	setModelFactsForTest(Object.fromEntries(models.map((m) => [`${m.provider}/${m.id}`, { releaseDate }])));
	const snapshot: CapabilitySnapshot = {
		fetchedAt: "2026-10-05T00:00:00Z",
		source: "test",
		rows: [
			{ id: "reference", slug: "claude-sonnet-5", creator: "anthropic", releaseDate, coding: 80 },
			...models.filter((m) => m.id !== "claude-sonnet-5").map((m) => ({ id: m.id, slug: slugCandidates(m.id)[0], creator: m.provider, releaseDate, coding: 70 })),
		],
	};
	setCapabilitySnapshotForTest(snapshot);
	return snapshot;
}

afterEach(() => vi.unstubAllEnvs());

describe("classifierCandidates: session-contained capability and context floor", () => {
	it("selects the cheapest same-route model meeting the existing capability and session context floors", () => {
		// The workhorse floor drops mini/nano. The chosen Codex variant is also the
		// cheapest remaining row with the session's 200k catalog window.
		const session = model("openai", "gpt-5.5", 10, 200_000);
		const available = [
			session,
			model("openai", "gpt-5.5-codex", 5, 200_000),
			model("openai", "gpt-5.5-large", 7, 400_000),
			model("openai", "gpt-5-mini", 0.25, 400_000),
			model("openai", "gpt-5-nano", 0.05, 400_000),
		];
		measure(available.slice(0, 3));
		const result = pickFull(available, session);
		expect(result.candidates[0]).toMatchObject({ model: available[1], source: "economical" });
		expect(result.candidates.every((candidate) => candidate.model.contextWindow >= session.contextWindow)).toBe(true);
		expect(result.candidates.every((candidate) => !/mini|nano/.test(candidate.model.id))).toBe(true);
		expect(result.fallback).toBeUndefined();
	});

	it("never leaves the session provider or gateway route", () => {
		const session = model("openrouter", "openai/gpt-5.1", 5, 200_000);
		const available = [
			session,
			model("openrouter", "openai/gpt-5.1-codex", 2, 200_000),
			model("openrouter", "anthropic/claude-sonnet-5", 1, 1_000_000),
		];
		measure(available);
		const result = pickFull(available, session);
		expect(result.candidates[0].model.id).toBe("openai/gpt-5.1-codex");
		for (const candidate of result.candidates) expect(candidate.model.id.startsWith("openai/")).toBe(true);
	});

	it("makes an unknown candidate context window ineligible", () => {
		const session = model("anthropic", "claude-opus-4-8", 15, 200_000);
		const unknownWindow = model("anthropic", "claude-sonnet-5", 3);
		const qualifying = model("anthropic", "claude-fable-5", 5, 200_000);
		const result = pickFull([session, unknownWindow, qualifying], session);
		expect(result.candidates[0].model).toBe(qualifying);
		expect(result.candidates.map((candidate) => candidate.model)).not.toContain(unknownWindow);
	});

	it("uses the session itself when its catalog context window is unknown", () => {
		const session = model("anthropic", "claude-opus-4-8", 15);
		const result = pickFull([session, model("anthropic", "claude-sonnet-5", 3, 1_000_000)], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "unknown-session-context-window" });
		expect(result.notices).toContainEqual(expect.objectContaining({ fallbackReason: "unknown-session-context-window" }));
	});

	it("uses the session itself with a reason when no model meets both floors", () => {
		const session = model("openai", "gpt-5-nano", 0.05, 1_000_000);
		// Mini is capable but cannot contain this session's catalog window; the
		// tiny session is terminal-only and cannot count as an automatic candidate.
		const result = pickFull([session, model("openai", "gpt-5-mini", 0.25, 200_000)], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
		expect(result.notices).toContainEqual(expect.objectContaining({ fallbackReason: "no-qualifying-model" }));
	});

	it("keeps qualified candidates ahead of the terminal session fallback", () => {
		const session = model("openai", "gpt-5.5", 10, 200_000);
		const qualified = model("openai", "gpt-5.5-codex", 5, 200_000);
		measure([session, qualified]);
		const chain = pickFull([session, qualified], session).candidates;
		expect(chain).toEqual([{ model: qualified, source: "economical" }, { model: session, source: "session" }]);
	});

	it("uses direct numeric cost, not the old cheap/workhorse/frontier tier preference", () => {
		const session = model("anthropic", "claude-opus-4-8", 15, 200_000);
		const workhorse = model("anthropic", "claude-sonnet-5", 10, 200_000);
		const cheaperFrontier = model("anthropic", "claude-fable-5", 2, 200_000);
		const result = pickFull([session, workhorse, cheaperFrontier], session);
		expect(result.candidates[0]).toMatchObject({ model: cheaperFrontier, source: "economical" });
	});

	it("does not upgrade a tiny session to an unscored larger-priced model", () => {
		const tinySession = model("openai", "gpt-5-nano", 0.05, 200_000);
		const capable = model("openai", "gpt-5.5-codex", 5, 200_000);
		const result = pickFull([tinySession, capable], tinySession);
		expect(result.candidates).toEqual([{ model: tinySession, source: "session" }]);
	});

	it("publishes a window reason when only the session can contain the session catalog", () => {
		const session = model("openai-codex", "gpt-6-astra", 10, 1_000_000);
		const sol = model("openai-codex", "gpt-6-sol", 5, 272_000);
		const terra = model("openai-codex", "gpt-5.6-terra", 2, 272_000);
		const result = pickFull([session, sol, terra], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
		expect(result.fallback?.text).toMatch(/window|context/i);
	});

	it("publishes why the session was retained when it is the cheapest qualified model", () => {
		const session = model("anthropic", "claude-opus-5", 1, 200_000);
		const other = model("anthropic", "claude-fable-5", 2, 200_000);
		const result = pickFull([session, other], session);
		expect(result.candidates[0]).toMatchObject({ model: session, source: "session" });
		expect(result.fallback).toMatchObject({ reason: "session-is-cheapest-qualified" });
		expect(result.fallback?.text).toMatch(/cheapest.*context|context.*cheapest/i);
	});
});

describe("classifierCandidates: below-frontier measured floor", () => {
	it("chooses the cheapest measured passer, not an unscored or smaller-window alternate", () => {
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const equal = model("openai", "gpt-5.6-terra", 2, 200_000);
		const larger = model("openai", "gpt-5.6-large", 3, 300_000);
		const smallerWindow = model("openai", "gpt-5.6-small", 0.1, 100_000);
		const unscored = model("openai", "gpt-5.6-unknown", 1, 200_000);
		const snapshot = measure([session, equal, larger, smallerWindow]);
		expect(capabilityFloor(snapshot, equal, session, "classifier")).toMatchObject({ verdict: "pass", floor: 70 });
		const result = pickFull([session, unscored, smallerWindow, larger, equal], session);
		expect(result.candidates.map((c) => c.model)).toEqual([equal, larger, session]);
		expect(result.fallback).toBeUndefined();
	});

	it("keeps a cheaper below-frontier session ahead of measured but more expensive alternates", () => {
		const session = model("openai", "gpt-5.6-sol", 1, 200_000);
		const alternate = model("openai", "gpt-5.6-terra", 2, 200_000);
		measure([session, alternate]);
		const result = pickFull([alternate, session], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }, { model: alternate, source: "economical" }]);
		expect(result.fallback?.reason).toBe("session-is-cheapest-qualified");
		expect(result.fallback?.text).toContain("no cheaper same-provider/route model is measured to be at least as capable");
	});

	it.each(["candidate", "session", "reference", "failed score"])("keeps the session when the alternate lacks a measured pass: %s", (missing) => {
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const alternate = model("openai", "gpt-5.6-terra", 2, 200_000);
		const snapshot = measure([session, alternate]);
		const slug = missing === "session" ? "gpt-5-6-sol" : missing === "reference" ? "claude-sonnet-5" : "gpt-5-6-terra";
		setCapabilitySnapshotForTest({
			...snapshot,
			rows: missing === "failed score"
				? snapshot.rows.map((row) => row.slug === slug ? { ...row, coding: 69 } : row)
				: snapshot.rows.filter((row) => row.slug !== slug),
		});
		expect(pickFull([session, alternate], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it("ignores a frontier prompt override and retains an unlisted session model", () => {
		vi.stubEnv("CC_PROMPT_TIER", "frontier");
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const alternate = model("openai", "gpt-5.6-terra", 2, 200_000);
		expect(pickFull([alternate], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it.each([
		["qwen/qwen3.8-27b", 0.42, "tiny", "qwen/qwen3.7-flash", 0.03, 1_000_000],
		["deepseek/deepseek-v4.1-flash", 0.3, "cheap", "deepseek/deepseek-v4-flash-vision-exp", 0.2156, 1_048_576],
		["z-ai/glm-5.3", 1.4, "workhorse", "z-ai/glm-5.3-flashx", 0.37, 1_048_576],
		["qwen/qwen3.8-max-0902", 2, "workhorse", "qwen/qwen3.5-plus-02-15", 0.26, 1_000_000],
	] as const)("keeps %s rather than an unscored alternate", (id, price, tier, alternateId, alternatePrice, window) => {
		setModelFactsForTest(undefined);
		const session = model("openrouter", id, price, window);
		const alternate = model("openrouter", alternateId, alternatePrice, window);
		expect(intrinsicTier(session)).toBe(tier);
		const result = pickFull([session, alternate], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
		expect(result.fallback?.text).toContain("no cheaper same-provider/route model is measured to be at least as capable");
	});
});

describe("classifierCandidates: frontier policy unchanged", () => {
	it.each([
		["anthropic", "claude-opus-5", 5, "claude-sonnet-5"],
		["anthropic", "claude-sonnet-5-5", 2, "claude-sonnet-5"],
		["openai-codex", "gpt-6-astra", 10, "gpt-5.6-terra"],
		["openai-codex", "gpt-6-sol", 2, "gpt-5.6-terra"],
	] as const)("keeps the unscored frontier choice for %s/%s", (provider, id, price, alternateId) => {
		vi.stubEnv("CC_PROMPT_TIER", "tiny");
		const session = model(provider, id, price, 200_000);
		const alternate = model(provider, alternateId, 2, 200_000);
		expect(intrinsicTier(session)).toBe("frontier");
		expect(pickFull([alternate, session], session).candidates).toEqual([
			{ model: alternate, source: "economical" }, { model: session, source: "session" },
		]);
	});
});

describe("classifierCandidates: cost and variants", () => {
	it("does not auto-select tiny, unpriced, or unsuitable variants", () => {
		const session = model("openrouter", "openai/gpt-5.1", 5, 200_000);
		const available = [
			session,
			model("openrouter", "openai/gpt-5-mini", 0.25, 200_000),
			model("openrouter", "openai/gpt-5-nano", 0.05, 200_000),
			model("openrouter", "openai/gpt-5.1:batch", 0.01, 200_000),
			model("openrouter", "openai/gpt-5.1-free", undefined, 200_000),
			model("openrouter", "openai/gpt-5.1-codex", 2, 200_000),
		];
		measure(available.filter((m) => !/mini|nano/.test(m.id)));
		const candidates = pickFull(available, session).candidates;
		expect(candidates[0].model.id).toBe("openai/gpt-5.1-codex");
		for (const candidate of candidates) {
			expect(candidate.model.id).not.toContain("nano");
			expect(candidate.model.id).not.toContain(":batch");
			expect(candidate.model.id).not.toContain("-free");
		}
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

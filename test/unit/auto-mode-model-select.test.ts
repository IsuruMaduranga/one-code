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
		const session = model("openai", "gpt-5.5", 10, 1_000_000);
		// Mini is cheaper but cannot contain this session's catalog window.
		const result = pickFull([session, model("openai", "gpt-5-mini", 0.25, 200_000)], session);
		expect(result.candidates[0]).toEqual({ model: session, source: "session" });
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
		expect(result.notices).toContainEqual(expect.objectContaining({ fallbackReason: "no-qualifying-model" }));
	});

	it("never screens a tiny session with a dearer measured model", () => {
		// Qwen 3.8 27B drew this 2.4T model at five times its input price.
		const session = model("openrouter", "qwen/qwen3.8-27b", 0.42, 1_000_000);
		const alternate = model("openrouter", "qwen/qwen3.8-2.4t-a95b", 2, 1_000_000);
		measure([session, alternate]);
		expect(intrinsicTier(session)).toBe("tiny");
		const result = pickFull([session, alternate], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
	});

	it.each([
		["qwen/qwen3.8-27b", 0.42, "qwen/qwen3.7-flash", 0.03],
		["deepseek/deepseek-v3.2", 0.25, "deepseek/deepseek-v4-flash", 0.028],
	] as const)("screens tiny %s with the subagents' model when nothing is measured", (id, price, subagentId, subagentPrice) => {
		setCapabilitySnapshotForTest(undefined);
		setModelFactsForTest(undefined);
		const session = model("openrouter", id, price, 163_840);
		const subagent = model("openrouter", subagentId, subagentPrice, 1_000_000);
		expect(intrinsicTier(session)).toBe("tiny");
		const result = pickFull([session, subagent], session);
		expect(result.candidates).toEqual([{ model: subagent, source: "subagent" }, { model: session, source: "session" }]);
		expect(result.fallback).toBeUndefined();
	});

	it("never takes an unscored model priced at or above the session's", () => {
		setCapabilitySnapshotForTest(undefined);
		setModelFactsForTest(undefined);
		const session = model("openrouter", "qwen/qwen3.8-27b", 0.42, 1_000_000);
		for (const price of [0.42, 0.5]) {
			const sibling = model("openrouter", "qwen/qwen3.7-flash", price, 1_000_000);
			expect(pickFull([session, sibling], session).candidates).toEqual([{ model: session, source: "session" }]);
		}
	});

	it("prefers a measured alternate to the subagents' model", () => {
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const measured = model("openai", "gpt-5.6-terra", 2, 200_000);
		const unscored = model("openai", "gpt-5.6-unknown", 1, 200_000);
		measure([session, measured]);
		expect(pickFull([session, unscored, measured], session).candidates).toEqual([
			{ model: measured, source: "economical" }, { model: session, source: "session" },
		]);
	});

	it("never screens with an experimental build, measured or not", () => {
		const session = model("openrouter", "deepseek/deepseek-v4.1-flash", 0.3, 1_048_576);
		const experimental = model("openrouter", "deepseek/deepseek-v4-flash-vision-exp", 0.2156, 1_048_576);
		measure([session, experimental]);
		expect(pickFull([session, experimental], session).candidates).toEqual([{ model: session, source: "session" }]);
		setCapabilitySnapshotForTest(undefined);
		expect(pickFull([session, experimental], session).candidates).toEqual([{ model: session, source: "session" }]);
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

	it("never screens with a model dearer than the session's", () => {
		const session = model("anthropic", "claude-opus-5", 1, 200_000);
		const other = model("anthropic", "claude-fable-5", 2, 200_000);
		const result = pickFull([session, other], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback).toMatchObject({ reason: "no-qualifying-model" });
	});

	it("keeps an alternate priced the same as the session", () => {
		const session = model("anthropic", "claude-opus-5", 2, 200_000);
		const other = model("anthropic", "claude-sonnet-5", 2, 200_000);
		expect(pickFull([session, other], session).candidates.map((entry) => entry.model.id)).toContain("claude-sonnet-5");
	});

	it("keeps an unpriced session on its own model", () => {
		const session = model("anthropic", "claude-opus-5", undefined, 200_000);
		const other = model("anthropic", "claude-sonnet-5", 1, 200_000);
		expect(pickFull([session, other], session).candidates).toEqual([{ model: session, source: "session" }]);
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

	it("drops measured alternates dearer than a below-frontier session", () => {
		const session = model("openai", "gpt-5.6-sol", 1, 200_000);
		const alternate = model("openai", "gpt-5.6-terra", 2, 200_000);
		measure([session, alternate]);
		const result = pickFull([alternate, session], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback?.reason).toBe("no-qualifying-model");
		expect(result.fallback?.text).toContain("is measured and in this session's tier, or at or above that tier by name");
	});

	it("screens with the subagents' model when the alternate has no score of its own", () => {
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const alternate = model("openai", "gpt-5.6-terra", 2, 200_000);
		const snapshot = measure([session, alternate]);
		setCapabilitySnapshotForTest({ ...snapshot, rows: snapshot.rows.filter((row) => row.slug !== "gpt-5-6-terra") });
		expect(pickFull([session, alternate], session).candidates).toEqual([{ model: alternate, source: "subagent" }, { model: session, source: "session" }]);
	});

	it("keeps the session when the measured alternate sits in a lower tier", () => {
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const alternate = model("openai", "gpt-5.6-luna", 0.2, 200_000);
		const snapshot = measure([session, alternate]);
		setCapabilitySnapshotForTest({ ...snapshot, rows: snapshot.rows.map((row) => row.slug === "gpt-5-6-luna" ? { ...row, coding: 50 } : row) });
		expect(intrinsicTier(alternate)).not.toBe(intrinsicTier(session));
		expect(pickFull([session, alternate], session).candidates).toEqual([{ model: session, source: "session" }]);
	});

	it.each(["session", "reference", "failed score"])("accepts a measured alternate in the session's tier without a pass: %s", (missing) => {
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
		expect(intrinsicTier(alternate)).toBe(intrinsicTier(session));
		expect(pickFull([session, alternate], session).candidates).toEqual([{ model: alternate, source: "economical" }, { model: session, source: "session" }]);
	});

	it("ignores a frontier prompt override and retains an unlisted session model", () => {
		vi.stubEnv("CC_PROMPT_TIER", "frontier");
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const alternate = model("openai", "gpt-5.6-terra", 2, 200_000);
		// Read as frontier, the unscored alternate would qualify outright.
		setCapabilitySnapshotForTest(undefined);
		expect(pickFull([alternate], session).candidates).toEqual([{ model: alternate, source: "subagent" }, { model: session, source: "session" }]);
	});

	it.each([
		["z-ai/glm-5.3", 1.4, "workhorse", "z-ai/glm-5.3-flashx", 0.37, 1_048_576],
		["qwen/qwen3.8-max-0902", 2, "workhorse", "qwen/qwen3.5-plus-02-15", 0.26, 1_000_000],
	] as const)("screens %s with the subagents' unscored model", (id, price, tier, alternateId, alternatePrice, window) => {
		setCapabilitySnapshotForTest(undefined);
		setModelFactsForTest(undefined);
		const session = model("openrouter", id, price, window);
		const alternate = model("openrouter", alternateId, alternatePrice, window);
		expect(intrinsicTier(session)).toBe(tier);
		const result = pickFull([session, alternate], session);
		expect(result.candidates).toEqual([{ model: alternate, source: "subagent" }, { model: session, source: "session" }]);
		expect(result.fallback).toBeUndefined();
	});

	it("keeps a session whose only cheaper sibling is below its tier by name", () => {
		setCapabilitySnapshotForTest(undefined);
		const session = model("openai", "gpt-5.6-sol", 5, 200_000);
		const lower = model("openai", "gpt-5.6-luna", 0.2, 200_000);
		expect(intrinsicTier(lower)).not.toBe(intrinsicTier(session));
		const result = pickFull([session, lower], session);
		expect(result.candidates).toEqual([{ model: session, source: "session" }]);
		expect(result.fallback?.text).toContain("is measured and in this session's tier, or at or above that tier by name");
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
		expect(describeCandidate({ model: model("openai", "gpt-5.6-terra", 2, 200_000), source: "subagent" })).toContain("subagents run on");
	});
});

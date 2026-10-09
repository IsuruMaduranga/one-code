import { describe, expect, it } from "vitest";
import { classifierCandidates, describeCandidate, isModelUnavailableError } from "../../extensions/auto-mode/model-select.ts";

/** Minimal structural stand-in; selection consults provider/id/cost/contextWindow. */
const model = (provider: string, id: string, input?: number, contextWindow?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 }, ...(contextWindow === undefined ? {} : { contextWindow }) }) as any;

const pickFull = (available: any[], sessionModel: any) => classifierCandidates({ available, sessionModel });

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

	it("selects a capable larger-priced model instead of a tiny session fallback", () => {
		const tinySession = model("openai", "gpt-5-nano", 0.05, 200_000);
		const capable = model("openai", "gpt-5.5-codex", 5, 200_000);
		const result = pickFull([tinySession, capable], tinySession);
		expect(result.candidates[0]).toMatchObject({ model: capable, source: "economical" });
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
		const session = model("anthropic", "claude-sonnet-5", 1, 200_000);
		const other = model("anthropic", "claude-fable-5", 2, 200_000);
		const result = pickFull([session, other], session);
		expect(result.candidates[0]).toMatchObject({ model: session, source: "session" });
		expect(result.fallback).toMatchObject({ reason: "session-is-cheapest-qualified" });
		expect(result.fallback?.text).toMatch(/cheapest.*context|context.*cheapest/i);
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

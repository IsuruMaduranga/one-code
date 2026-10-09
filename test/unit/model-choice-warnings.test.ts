import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifierCandidates } from "../../extensions/auto-mode/model-select.ts";
import { chosenModelWarnings } from "../../extensions/lib/model-choice-warnings.ts";
import { setModelTierOverridesForTest } from "../../extensions/lib/model-tier.ts";
import { pinReleaseDates } from "./catalog-fixture.ts";

const model = (provider: string, id: string, input: number, contextWindow = 200_000) =>
	({ provider, id, name: id, contextWindow, cost: { input, output: input * 4, cacheRead: 0, cacheWrite: 0 }, api: "openai-completions" }) as Model<Api>;

const session = model("openai", "gpt-x-big", 5, 1_000_000);
const mid = model("openai", "gpt-x-mid", 2, 1_000_000);
const small = model("openai", "gpt-x-small", 0.5, 1_000_000);
const narrow = model("openai", "gpt-x-narrow", 2, 272_000);

function tiers() {
	setModelTierOverridesForTest({
		"openai/gpt-x-big": "workhorse",
		"openai/gpt-x-mid": "cheap",
		"openai/gpt-x-small": "tiny",
		"openai/gpt-x-narrow": "workhorse",
	});
}

describe("chosenModelWarnings", () => {
	it("warns when the chosen model is two or more tiers below the session's, not one", () => {
		tiers();
		const kinds = (chosen: Model<Api>) => chosenModelWarnings({ available: [session, mid, small], sessionModel: session, chosen, role: "subagent" }).map((w) => w.kind);
		expect(kinds(small)).toEqual(["weaker"]);
		expect(kinds(mid)).toEqual([]);
		const [warning] = chosenModelWarnings({ available: [session, small], sessionModel: session, chosen: small, role: "classifier" });
		expect(warning.text).toContain("tiny-tier model, two or more tiers below this session's openai/gpt-x-big (workhorse)");
		expect(warning.text).toContain("weak permission boundary");
		expect(warning.fix).toContain("/auto-mode model clear");
	});

	it("warns about a smaller context window for the classifier only", () => {
		tiers();
		const classifier = chosenModelWarnings({ available: [session, narrow], sessionModel: session, chosen: narrow, role: "classifier" });
		expect(classifier.map((w) => w.kind)).toEqual(["window"]);
		expect(classifier[0].text).toContain("272,000-token context window, smaller than this session's 1,000,000");
		expect(chosenModelWarnings({ available: [session, narrow], sessionModel: session, chosen: narrow, role: "subagent" })).toEqual([]);
	});

	it("names a newer model in the chosen model's line, in the role's own command, unless suggestions are off", () => {
		const old = model("openai", "gpt-5.6-sol", 2, 1_000_000);
		const next = model("openai", "gpt-6.1-sol", 2, 1_000_000);
		pinReleaseDates({ "openai/gpt-5.6-sol": { releaseDate: "2026-07-09" }, "openai/gpt-6.1-sol": { releaseDate: "2026-09-29" } });
		setModelTierOverridesForTest({ "openai/gpt-5.6-sol": "workhorse", "openai/gpt-6.1-sol": "workhorse" });
		const [subagent] = chosenModelWarnings({ available: [old, next], sessionModel: next, chosen: old, role: "subagent" });
		expect(subagent.kind).toBe("newer");
		expect(subagent.text).toContain("gpt-6.1-sol is newer than gpt-5.6-sol");
		expect(subagent.fix).toBe("Switch with /subagent openai/gpt-6.1-sol.");
		const [classifier] = chosenModelWarnings({ available: [old, next], sessionModel: next, chosen: old, role: "classifier" });
		expect(classifier.fix).toBe("Switch with /auto-mode model openai/gpt-6.1-sol.");
		expect(chosenModelWarnings({ available: [old, next], sessionModel: next, chosen: old, role: "classifier", suggestNewer: false })).toEqual([]);
	});

	it("warns about a moving alias or an experimental build as the classifier only", () => {
		tiers();
		const alias = model("openai", "gpt-x-mid-latest", 2, 1_000_000);
		const exp = model("openai", "gpt-x-mid-exp", 2, 1_000_000);
		setModelTierOverridesForTest({ "openai/gpt-x-big": "workhorse", "openai/gpt-x-mid-latest": "workhorse", "openai/gpt-x-mid-exp": "workhorse" });
		const [moving] = chosenModelWarnings({ available: [session, alias], sessionModel: session, chosen: alias, role: "classifier" });
		expect(moving).toMatchObject({ kind: "unstable", text: expect.stringContaining("a moving alias") });
		expect(moving.fix).toContain("/auto-mode model clear");
		const [experimental] = chosenModelWarnings({ available: [session, exp], sessionModel: session, chosen: exp, role: "classifier" });
		expect(experimental).toMatchObject({ kind: "unstable", text: expect.stringContaining("an experimental build") });
		expect(chosenModelWarnings({ available: [session, alias], sessionModel: session, chosen: alias, role: "subagent" })).toEqual([]);
	});

	it("says nothing about the session model itself", () => {
		tiers();
		expect(chosenModelWarnings({ available: [session], sessionModel: session, chosen: session, role: "classifier" })).toEqual([]);
	});
});

describe("classifierCandidates with autoMode.classifierModel", () => {
	it("leads the chain with the chosen model and carries its warnings", () => {
		tiers();
		const { candidates, notices, fallback } = classifierCandidates({ available: [session, mid, small], sessionModel: session, configured: "openai/gpt-x-small" });
		expect(candidates[0]).toEqual({ model: small, source: "configured" });
		expect(candidates.at(-1)).toEqual({ model: session, source: "session" });
		expect(fallback).toBeUndefined();
		expect(notices).toEqual([expect.objectContaining({ level: "warning", choiceWarning: "weaker" })]);
	});

	it("falls back to the automatic chain, with a warning, when the chosen model is not available", () => {
		tiers();
		const { candidates, notices } = classifierCandidates({ available: [session], sessionModel: session, configured: "openai/gpt-x-gone" });
		expect(candidates).toEqual([{ model: session, source: "session" }]);
		expect(notices[0]).toMatchObject({ level: "warning", text: expect.stringContaining("openai/gpt-x-gone is not an available model") });
	});

	it("uses a cross-provider choice stamped for this session, and replaces a stale one", () => {
		tiers();
		const other = model("anthropic", "claude-sonnet-5-5", 2, 1_000_000);
		const current = classifierCandidates({ available: [session, other], sessionModel: session, configured: "anthropic/claude-sonnet-5-5", configuredSetForContainment: "openai" });
		expect(current.candidates[0]).toEqual({ model: other, source: "configured" });
		expect(current.notices[0]).toMatchObject({ level: "info", text: expect.stringContaining("so those go to that provider") });
		const stale = classifierCandidates({ available: [session, other], sessionModel: session, configured: "anthropic/claude-sonnet-5-5", configuredSetForContainment: "anthropic" });
		expect(stale.candidates.some((entry) => entry.model === other)).toBe(false);
		expect(stale.notices[0]).toMatchObject({ level: "warning", text: expect.stringContaining("was set for a different provider") });
	});
});

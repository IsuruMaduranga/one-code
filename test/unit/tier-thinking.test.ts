/**
 * When the profile's per-tier thinking level applies and when the user's
 * choice wins (lib/models/tier-thinking.ts): every skip reason, each tier, the
 * model-switch cases, a hand-picked level surviving a switch, and the branch
 * reading that a resume, /fork and /tree rely on.
 */
import { describe, expect, it } from "vitest";
import {
	autoThinkingAction,
	branchHasMessages,
	type LevelChoices,
	levelChoices,
	levelSource,
	PI_DEFAULT_THINKING_LEVEL,
	TIER_THINKING_STATE,
	tierThinkingAction,
} from "../../extensions/lib/models/tier-thinking.ts";
import { PROMPT_TIERS } from "../../extensions/lib/models/model-tier.ts";
import type { ThinkingDefaults } from "../../extensions/lib/profile/thinking-defaults.ts";
import { stateEntry } from "./helpers/state-entry.ts";

const none: LevelChoices = { launchFlag: false };
const declared: ThinkingDefaults = { workhorse: "medium", cheap: "low", tiny: "low" };

let ids = 0;
const entry = (type: string, extra: Record<string, unknown> = {}) => ({ type, id: `e${++ids}`, parentId: null, ...extra });
const modelChange = () => entry("model_change", { provider: "p", modelId: "m" });
const levelChange = (thinkingLevel: string) => entry("thinking_level_change", { thinkingLevel });
const marker = (source: string, level: string) => stateEntry(TIER_THINKING_STATE, { source, level });
const message = () => entry("message", { message: { role: "user" } });

/** A new session's opening entries, as pi writes them. */
const opening = () => [modelChange(), levelChange("medium")];

describe("levelSource reads who set the level from the branch", () => {
	it("is pi's for a new session, with or without a model", () => {
		expect(levelSource([])).toBe("pi");
		expect(levelSource(opening())).toBe("pi");
		expect(levelSource([levelChange("medium")])).toBe("pi");
	});

	it("is the default's after its state entry, and stays so across pi's switch entries", () => {
		const applied = [...opening(), levelChange("low"), marker("default", "low")];
		expect(levelSource(applied)).toBe("default");
		// A switch: pi records the model, then the level it carried or fitted.
		expect(levelSource([...applied, message(), modelChange(), levelChange("high")])).toBe("default");
		// A switch that kept the level records no level change.
		expect(levelSource([...applied, modelChange()])).toBe("default");
	});

	it("is the user's after a change no state entry claims (shift+tab, an RPC client), and stays so across switches", () => {
		const picked = [...opening(), levelChange("low"), marker("default", "low"), message(), levelChange("high")];
		expect(levelSource(picked)).toBe("user");
		expect(levelSource([...picked, modelChange(), levelChange("medium")])).toBe("user");
		// A level picked before any default applied.
		expect(levelSource([...opening(), levelChange("xhigh")])).toBe("user");
	});

	it("takes /effort's own entry, even for the level already in force", () => {
		expect(levelSource([...opening(), levelChange("low"), marker("default", "low"), marker("user", "low")])).toBe("user");
		// /effort auto gives the level back.
		expect(levelSource([...opening(), levelChange("high"), marker("user", "high"), levelChange("low"), marker("default", "low")])).toBe("default");
		expect(levelSource([...opening(), levelChange("high"), levelChange("medium"), marker("pi", "medium")])).toBe("pi");
	});

	it("ignores a malformed state entry and other keys", () => {
		expect(levelSource([...opening(), levelChange("high"), stateEntry(TIER_THINKING_STATE, { source: "someone" })])).toBe("user");
		expect(levelSource([...opening(), levelChange("high"), stateEntry("ultracode", { on: true, level: "high" })])).toBe("user");
	});

	it("reads a resumed or forked copy of the branch the same way", () => {
		const branch = [...opening(), levelChange("low"), marker("default", "low"), message(), entry("custom", { customType: "other", data: {} })];
		expect(levelSource(structuredClone(branch))).toBe("default");
	});
});

describe("branchHasMessages", () => {
	it("is true once a conversation exists", () => {
		expect(branchHasMessages(opening())).toBe(false);
		expect(branchHasMessages([...opening(), marker("default", "low")])).toBe(false);
		expect(branchHasMessages([...opening(), message()])).toBe(true);
	});
});

describe("levelChoices reads pi's effective settings", () => {
	const model = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };
	it("finds the level saved for the model and the global default", () => {
		expect(levelChoices({ modelThinkingLevels: { "openrouter/deepseek/deepseek-v4.1-flash": "high", "a/b": "low" }, defaultThinkingLevel: "xhigh" }, model, false)).toEqual({ saved: "high", globalDefault: "xhigh", launchFlag: false });
		expect(levelChoices({ modelThinkingLevels: { "a/b": "low" } }, model, true)).toEqual({ launchFlag: true });
		expect(levelChoices(undefined, model, false)).toEqual({ launchFlag: false });
		expect(levelChoices({ modelThinkingLevels: null, defaultThinkingLevel: 3 }, model, false)).toEqual({ launchFlag: false });
	});
});

describe("tierThinkingAction", () => {
	it.each(PROMPT_TIERS)("a new session on a %s model starts at the tier's declared level, or pi's when none", (tier) => {
		const action = tierThinkingAction({ boundary: "start", declared: declared[tier], choices: none, source: "pi" });
		expect(action).toEqual(declared[tier] === undefined ? undefined : { level: declared[tier], source: "default" });
	});

	it.each([
		["a level saved for the model", { ...none, saved: "high" }],
		["pi's global default", { ...none, globalDefault: "high" }],
		["a launch flag", { launchFlag: true }],
	] as const)("leaves the level alone under %s, at every boundary", (_label, choices) => {
		for (const boundary of ["start", "switch", "child"] as const) {
			for (const source of ["pi", "default"] as const) expect(tierThinkingAction({ boundary, declared: "low", choices, source })).toBeUndefined();
		}
	});

	it("leaves a level the user picked in the session, at a start and at a switch", () => {
		expect(tierThinkingAction({ boundary: "start", declared: "low", choices: none, source: "user" })).toBeUndefined();
		// The hand-picked level survives a switch to a model with a default, and to one without.
		expect(tierThinkingAction({ boundary: "switch", declared: "low", choices: none, source: "user" })).toBeUndefined();
		expect(tierThinkingAction({ boundary: "switch", declared: undefined, choices: none, source: "user" })).toBeUndefined();
	});

	it("follows a switch between tiers that declare a level", () => {
		// cheap (low) to workhorse (medium), and back.
		expect(tierThinkingAction({ boundary: "switch", declared: "medium", choices: none, source: "default" })).toEqual({ level: "medium", source: "default" });
		expect(tierThinkingAction({ boundary: "switch", declared: "low", choices: none, source: "default" })).toEqual({ level: "low", source: "default" });
		// From a model without a default (pi's own level) to one with.
		expect(tierThinkingAction({ boundary: "switch", declared: "low", choices: none, source: "pi" })).toEqual({ level: "low", source: "default" });
	});

	it("gives the level back to pi on a switch to a tier without a default, only while the level is the default's", () => {
		expect(tierThinkingAction({ boundary: "switch", declared: undefined, choices: none, source: "default" })).toEqual({ level: PI_DEFAULT_THINKING_LEVEL, source: "pi" });
		expect(PI_DEFAULT_THINKING_LEVEL).toBe("medium");
		// pi's own level on both sides: nothing to give back.
		expect(tierThinkingAction({ boundary: "switch", declared: undefined, choices: none, source: "pi" })).toBeUndefined();
		// A start on such a tier leaves pi's level.
		expect(tierThinkingAction({ boundary: "start", declared: undefined, choices: none, source: "pi" })).toBeUndefined();
	});

	it("starts a subagent at its own model's tier level", () => {
		expect(tierThinkingAction({ boundary: "child", declared: "low", choices: none, source: "pi" })).toEqual({ level: "low", source: "default" });
		expect(tierThinkingAction({ boundary: "child", declared: undefined, choices: none, source: "pi" })).toBeUndefined();
	});
});

describe("autoThinkingAction (/effort auto)", () => {
	it("restores pi's global default, else the tier's, else pi's own", () => {
		expect(autoThinkingAction({ declared: "low", globalDefault: "high" })).toEqual({ level: "high", source: "pi" });
		expect(autoThinkingAction({ declared: "low", globalDefault: undefined })).toEqual({ level: "low", source: "default" });
		expect(autoThinkingAction({ declared: undefined, globalDefault: undefined })).toEqual({ level: "medium", source: "pi" });
	});
});

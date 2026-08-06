import { describe, expect, it } from "vitest";
import type { PermissionMode } from "../../extensions/permissions/matcher.ts";
import {
	MODE_BADGES,
	modeBadge,
	nextMode,
	permissionModeDisplay,
	shortModelName,
} from "../../extensions/permissions/modes.ts";
import { normalizePermissionMode } from "../../extensions/permissions/settings.ts";

describe("nextMode", () => {
	it("cycles manual → acceptEdits → plan → manual", () => {
		expect(nextMode("default", { bypassInCycle: false, autoInCycle: false })).toBe("acceptEdits");
		expect(nextMode("acceptEdits", { bypassInCycle: false, autoInCycle: false })).toBe("plan");
		expect(nextMode("plan", { bypassInCycle: false, autoInCycle: false })).toBe("default");
	});

	it("includes bypass only when the session started with it", () => {
		expect(nextMode("plan", { bypassInCycle: true, autoInCycle: false })).toBe("bypassPermissions");
		expect(nextMode("bypassPermissions", { bypassInCycle: true, autoInCycle: false })).toBe("default");
	});

	it("exits a non-cycle mode to the cycle start", () => {
		// dontAsk never cycles in; bypass is outside the cycle unless enabled at start.
		expect(nextMode("dontAsk", { bypassInCycle: false, autoInCycle: false })).toBe("default");
		expect(nextMode("bypassPermissions", { bypassInCycle: false, autoInCycle: false })).toBe("default");
	});

	it("puts auto last, after bypass, matching Claude Code's order", () => {
		expect(nextMode("plan", { bypassInCycle: false, autoInCycle: true })).toBe("auto");
		expect(nextMode("auto", { bypassInCycle: false, autoInCycle: true })).toBe("default");
		expect(nextMode("plan", { bypassInCycle: true, autoInCycle: true })).toBe("bypassPermissions");
		expect(nextMode("bypassPermissions", { bypassInCycle: true, autoInCycle: true })).toBe("auto");
	});

	it("skips auto when no classifier model is reachable", () => {
		// Auto mode with no model would block every call, so it leaves the cycle.
		expect(nextMode("plan", { bypassInCycle: false, autoInCycle: false })).toBe("default");
	});
});

describe("MODE_BADGES", () => {
	it("has a footer badge for every mode", () => {
		const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];
		for (const mode of modes) {
			expect(MODE_BADGES[mode], mode).toBeTruthy();
		}
	});

	it("uses Claude Code's strings", () => {
		expect(MODE_BADGES.default).toBe("⏸ manual mode on");
		expect(MODE_BADGES.acceptEdits).toBe("⏵⏵ accept edits on");
		expect(MODE_BADGES.plan).toBe("⏸ plan mode on");
		expect(MODE_BADGES.auto).toBe("⏵⏵ auto mode on");
	});
});

describe("modeBadge", () => {
	it("leaves non-auto modes as their plain badge", () => {
		expect(modeBadge("plan", { paused: false })).toBe(MODE_BADGES.plan);
		expect(modeBadge("acceptEdits", {})).toBe(MODE_BADGES.acceptEdits);
	});

	it("names the classifier model beside auto mode", () => {
		// The model reads the user's prompts and CLAUDE.md, so which one it is
		// belongs on screen rather than buried in a command.
		expect(modeBadge("auto", { classifierModel: "claude-haiku-4-5" })).toBe("⏵⏵ auto mode on · haiku-4-5");
	});

	it("says nothing about the model before one is settled", () => {
		expect(modeBadge("auto", {})).toBe(MODE_BADGES.auto);
	});

	it("keeps the model visible while paused", () => {
		expect(modeBadge("auto", { paused: true, classifierModel: "gpt-5-mini" })).toBe("⏸ auto mode paused · 5-mini");
	});

	it("only shows paused for auto mode", () => {
		expect(modeBadge("default", { paused: true })).toBe(MODE_BADGES.default);
	});
});

describe("shortModelName", () => {
	it("drops a vendor prefix and a date stamp", () => {
		expect(shortModelName("anthropic/claude-haiku-4-5-20251001")).toBe("haiku-4-5");
		expect(shortModelName("google/gemini-2.5-flash")).toBe("2.5-flash");
	});

	it("leaves an already-short id recognisable", () => {
		expect(shortModelName("llama-3.3-70b-versatile")).toBe("3.3-70b-versatile");
		expect(shortModelName("qwen3-coder")).toBe("qwen3-coder");
	});
});

describe("normalizePermissionMode", () => {
	it("accepts internal names and Claude Code's manual alias", () => {
		expect(normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
		expect(normalizePermissionMode("manual")).toBe("default");
		expect(normalizePermissionMode("dontAsk")).toBe("dontAsk");
	});

	it("accepts auto", () => {
		expect(normalizePermissionMode("auto")).toBe("auto");
	});

	it("rejects unknown values", () => {
		expect(normalizePermissionMode("")).toBeUndefined();
		expect(normalizePermissionMode("turbo")).toBeUndefined();
		expect(normalizePermissionMode(42)).toBeUndefined();
	});
});

describe("permissionModeDisplay", () => {
	it("shows plain modes as their name", () => {
		expect(permissionModeDisplay({ mode: "default", paused: false })).toBe("default");
		expect(permissionModeDisplay({ mode: "plan", paused: false })).toBe("plan");
	});

	it("names the classifier in auto mode — that model reads the user's prompts", () => {
		expect(
			permissionModeDisplay({ mode: "auto", paused: false, classifier: "openai/gpt-5-mini", pinned: true }),
		).toBe("auto · classifier 5-mini");
	});

	it("marks a classifier that is still the plan rather than the settled fact", () => {
		expect(
			permissionModeDisplay({ mode: "auto", paused: false, classifier: "anthropic/claude-haiku-4-5", pinned: false }),
		).toBe("auto · classifier haiku-4-5 (planned)");
	});

	it("shows the paused state and the missing-model state", () => {
		expect(permissionModeDisplay({ mode: "auto", paused: true, classifier: "openai/gpt-5-mini", pinned: true })).toBe(
			"auto (paused) · classifier 5-mini",
		);
		expect(permissionModeDisplay({ mode: "auto", paused: false })).toBe(
			"auto · classifier no model available (planned)",
		);
	});
});

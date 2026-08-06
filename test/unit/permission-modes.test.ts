import { describe, expect, it } from "vitest";
import type { PermissionMode } from "../../extensions/permissions/matcher.ts";
import { MODE_BADGES, nextMode } from "../../extensions/permissions/modes.ts";
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

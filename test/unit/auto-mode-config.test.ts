import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoModeSettingsPaths, loadAutoModeConfig, spliceDefaults } from "../../extensions/auto-mode/config.ts";
import { DEFAULT_HARD_DENY, DEFAULT_SOFT_DENY } from "../../extensions/auto-mode/defaults.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cc-automode-"));
	mkdirSync(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const writeUserSettings = (data: unknown) =>
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(data));

describe("spliceDefaults", () => {
	it("substitutes $defaults in place, preserving surrounding order", () => {
		expect(spliceDefaults(["before", "$defaults", "after"], ["d1", "d2"])).toEqual([
			"before",
			"d1",
			"d2",
			"after",
		]);
	});

	it("returns the defaults when nothing is configured", () => {
		expect(spliceDefaults(undefined, ["d1"])).toEqual(["d1"]);
	});

	it("replaces the list wholesale when $defaults is omitted", () => {
		// Documented and occasionally intended — /auto-mode config shows the result.
		expect(spliceDefaults(["only mine"], ["d1"])).toEqual(["only mine"]);
	});
});

describe("loadAutoModeConfig", () => {
	it("returns the built-in rules with no settings present", () => {
		const config = loadAutoModeConfig(home);
		expect(config.hard_deny).toEqual(DEFAULT_HARD_DENY);
		expect(config.soft_deny).toEqual(DEFAULT_SOFT_DENY);
		expect(config.classifyAllShell).toBe(false);
	});

	it("splices user entries around the defaults", () => {
		writeUserSettings({
			autoMode: {
				environment: ["$defaults", "Source control: github.example.com/acme"],
				allow: ["$defaults", "Deploying to staging is allowed"],
			},
		});
		const config = loadAutoModeConfig(home);
		expect(config.environment).toContain("Source control: github.example.com/acme");
		expect(config.environment.length).toBeGreaterThan(1);
		expect(config.allow).toContain("Deploying to staging is allowed");
	});

	it("reads classifyAllShell and classifierModel", () => {
		writeUserSettings({ autoMode: { classifyAllShell: true, classifierModel: "anthropic/claude-haiku-4-5" } });
		const config = loadAutoModeConfig(home);
		expect(config.classifyAllShell).toBe(true);
		expect(config.classifierModel).toBe("anthropic/claude-haiku-4-5");
	});

	it("ignores malformed files rather than failing open", () => {
		writeFileSync(join(home, ".claude", "settings.json"), "{not json");
		expect(loadAutoModeConfig(home).hard_deny).toEqual(DEFAULT_HARD_DENY);
	});

	it("drops non-string entries", () => {
		writeUserSettings({ autoMode: { hard_deny: ["real rule", 42, null, "  "] } });
		expect(loadAutoModeConfig(home).hard_deny).toEqual(["real rule"]);
	});

	it("never reads autoMode from project settings", () => {
		// A repo that could grant itself classifier allow rules could switch off the
		// gate meant to contain it, so project files are not a configuration source.
		const paths = autoModeSettingsPaths(home);
		expect(paths.some((path) => path.includes("settings.local.json"))).toBe(false);
		for (const path of paths) {
			expect(path.startsWith(home) || path.startsWith("/etc") || path.startsWith("/Library") || path.startsWith("C:\\")).toBe(
				true,
			);
		}
	});
});

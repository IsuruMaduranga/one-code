import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	autoModeSettingsPaths,
	loadAutoModeConfig,
	loadAutoModeConfigWithDiagnostics,
	spliceDefaults,
} from "../../extensions/auto-mode/config.ts";
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

	it("reports a skipped malformed file instead of staying silent about it", () => {
		// The file is still skipped (the gate must not die on a typo), but a user
		// whose rules were silently never loaded believes protections are in force.
		writeFileSync(join(home, ".claude", "settings.json"), "{not json");
		const { diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("invalid JSON"))).toBe(true);
	});

	it("reports unknown and mistyped autoMode keys", () => {
		writeUserSettings({
			autoMode: { clasifierModel: "typo/model", classifyAllShell: "yes", hard_deny: "not an array" },
		});
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes('unknown autoMode key "clasifierModel"'))).toBe(true);
		expect(diagnostics.some((line) => line.includes("classifyAllShell must be a boolean"))).toBe(true);
		expect(diagnostics.some((line) => line.includes("hard_deny must be an array"))).toBe(true);
		// Lenient loading: the mistyped fields fall back rather than failing.
		expect(config.classifyAllShell).toBe(false);
		expect(config.hard_deny).toEqual(DEFAULT_HARD_DENY);
	});

	it("warns when a list omits $defaults and so replaces the built-ins", () => {
		writeUserSettings({ autoMode: { soft_deny: ["only my rule"] } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("REPLACES the built-in soft_deny"))).toBe(true);
		// Still applied — replacement is documented and occasionally intended.
		expect(config.soft_deny).toEqual(["only my rule"]);
	});

	it("reports dropped non-string entries", () => {
		writeUserSettings({ autoMode: { hard_deny: ["$defaults", 42] } });
		const { diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("hard_deny[1]"))).toBe(true);
	});

	it("stays quiet on a clean configuration", () => {
		writeUserSettings({ autoMode: { soft_deny: ["$defaults", "extra rule"], classifyAllShell: true } });
		expect(loadAutoModeConfigWithDiagnostics(home).diagnostics).toEqual([]);
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

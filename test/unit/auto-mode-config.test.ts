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
import { DEFAULT_ENVIRONMENT } from "../../extensions/auto-mode/defaults.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cc-automode-"));
	mkdirSync(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const writeUserSettings = (data: unknown) => writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(data));

describe("spliceDefaults", () => {
	it("substitutes $defaults in place, preserving surrounding order", () => {
		expect(spliceDefaults(["before", "$defaults", "after"], ["d1", "d2"])).toEqual(["before", "d1", "d2", "after"]);
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
	it("returns the built-in environment with no settings present", () => {
		const config = loadAutoModeConfig(home);
		expect(config.environment).toEqual(DEFAULT_ENVIRONMENT);
		expect(config.classifyAllShell).toBe(false);
	});

	it("splices user entries around the environment defaults", () => {
		writeUserSettings({
			autoMode: { environment: ["$defaults", "Source control: github.example.com/acme"] },
		});
		const config = loadAutoModeConfig(home);
		expect(config.environment).toContain("Source control: github.example.com/acme");
		expect(config.environment.length).toBe(DEFAULT_ENVIRONMENT.length + 1);
	});

	it("reads classifyAllShell and classifierModel", () => {
		writeUserSettings({ autoMode: { classifyAllShell: true, classifierModel: "anthropic/claude-haiku-4-5" } });
		const config = loadAutoModeConfig(home);
		expect(config.classifyAllShell).toBe(true);
		expect(config.classifierModel).toBe("anthropic/claude-haiku-4-5");
	});

	it("ignores malformed files rather than failing open", () => {
		writeFileSync(join(home, ".claude", "settings.json"), "{not json");
		expect(loadAutoModeConfig(home).environment).toEqual(DEFAULT_ENVIRONMENT);
	});

	it("drops non-string environment entries", () => {
		writeUserSettings({ autoMode: { environment: ["real rule", 42, null, "  "] } });
		expect(loadAutoModeConfig(home).environment).toEqual(["real rule"]);
	});

	it("reports a skipped malformed file instead of staying silent about it", () => {
		writeFileSync(join(home, ".claude", "settings.json"), "{not json");
		const { diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("invalid JSON"))).toBe(true);
	});

	it("warns that the retired rule-list keys are no longer used", () => {
		// The ruleset is now CC's fixed monolith; a user who still has these keys
		// must be told they are ignored rather than silently believing they apply.
		writeUserSettings({ autoMode: { hard_deny: ["x"], soft_deny: ["y"], allow: ["z"] } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		for (const key of ["hard_deny", "soft_deny", "allow"]) {
			expect(diagnostics.some((line) => line.includes(`autoMode.${key} is no longer used`))).toBe(true);
		}
		// They are not "unknown key" diagnostics — retired, and specifically named.
		expect(diagnostics.some((line) => line.includes('unknown autoMode key "hard_deny"'))).toBe(false);
		// The rest of the config still loads.
		expect(config.environment).toEqual(DEFAULT_ENVIRONMENT);
	});

	it("reports unknown and mistyped autoMode keys", () => {
		writeUserSettings({
			autoMode: { clasifierModel: "typo/model", classifyAllShell: "yes", environment: "not an array" },
		});
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes('unknown autoMode key "clasifierModel"'))).toBe(true);
		expect(diagnostics.some((line) => line.includes("classifyAllShell must be a boolean"))).toBe(true);
		expect(diagnostics.some((line) => line.includes("environment must be an array"))).toBe(true);
		// Lenient loading: the mistyped fields fall back rather than failing.
		expect(config.classifyAllShell).toBe(false);
		expect(config.environment).toEqual(DEFAULT_ENVIRONMENT);
	});

	it("warns when environment omits $defaults and so replaces the built-ins", () => {
		writeUserSettings({ autoMode: { environment: ["only my slot"] } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("REPLACES the built-in environment"))).toBe(true);
		expect(config.environment).toEqual(["only my slot"]);
	});

	it("reports dropped non-string environment entries", () => {
		writeUserSettings({ autoMode: { environment: ["$defaults", 42] } });
		const { diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("environment[1]"))).toBe(true);
	});

	it("stays quiet on a clean configuration", () => {
		writeUserSettings({ autoMode: { environment: ["$defaults", "extra slot"], classifyAllShell: true } });
		expect(loadAutoModeConfigWithDiagnostics(home).diagnostics).toEqual([]);
	});

	it("never reads autoMode from project settings", () => {
		// A repo that could grant itself classifier permissions could switch off the
		// gate meant to contain it, so project files are not a configuration source.
		const paths = autoModeSettingsPaths(home);
		expect(paths.some((path) => path.includes("settings.local.json"))).toBe(false);
		for (const path of paths) {
			expect(
				path.startsWith(home) || path.startsWith("/etc") || path.startsWith("/Library") || path.startsWith("C:\\"),
			).toBe(true);
		}
	});
});

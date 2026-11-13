/**
 * Auto mode's configuration as the base reads it from the product's own
 * settings file. Reading Claude Code's settings alongside it is One Code's
 * source provider's business (profile/test/auto-mode-config-claude.test.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	autoModeSettingsPaths,
	borrowedUserPermissionAllow,
	loadAutoModeConfig,
	loadAutoModeConfigWithDiagnostics,
	productPermissionAllow,
	persistClassifierModel,
	spliceDefaults,
} from "../../extensions/lib/rules/auto-mode-config.ts";
import { defaultEnvironment } from "../../extensions/safety/permissions/auto-mode/classifier-prompt.ts";
import { productSettingsPath } from "../../extensions/lib/profile/product-settings.ts";
import { tempHome } from "./helpers/temp-home.ts";

let home: string;

beforeEach(() => {
	home = tempHome("cc-automode-").home;
	mkdirSync(dirname(productSettingsPath(home)), { recursive: true });
});

/** The product's own user settings (`~/<state dir>/settings.json`). */
const writeUserSettings = (data: unknown) => writeFileSync(productSettingsPath(home), JSON.stringify(data));

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
		expect(config.environment).toEqual(defaultEnvironment());
		expect(config.classifyAllShell).toBe(false);
	});

	it("splices user entries around the environment defaults", () => {
		writeUserSettings({
			autoMode: { environment: ["$defaults", "Source control: github.example.com/acme"] },
		});
		const config = loadAutoModeConfig(home);
		expect(config.environment).toContain("Source control: github.example.com/acme");
		expect(config.environment.length).toBe(defaultEnvironment().length + 1);
	});

	it("reads classifierModel and its stamp from the product's settings", () => {
		writeUserSettings({ autoMode: { classifyAllShell: true, classifierModel: "anthropic/claude-haiku-4-5", classifierModelSetFor: "anthropic" } });
		const config = loadAutoModeConfig(home);
		expect(config.classifyAllShell).toBe(true);
		expect(config.classifierModel).toBe("anthropic/claude-haiku-4-5");
		expect(config.classifierModelSetFor).toBe("anthropic");
	});

	it("persists and clears classifierModel without touching other keys", () => {
		writeUserSettings({ autoMode: { environment: ["x"] }, other: 1 });
		persistClassifierModel("openai/gpt-6-sol", home, "openai");
		expect(loadAutoModeConfig(home)).toMatchObject({ classifierModel: "openai/gpt-6-sol", classifierModelSetFor: "openai" });
		persistClassifierModel(undefined, home);
		const saved = JSON.parse(readFileSync(productSettingsPath(home), "utf8"));
		expect(saved).toEqual({ autoMode: { environment: ["x"] }, other: 1 });
	});

	it("flags a classifierModel that is not a model spec", () => {
		writeUserSettings({ autoMode: { classifierModel: 42 } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.classifierModel).toBeUndefined();
		expect(diagnostics.some((line) => line.includes("autoMode.classifierModel must be"))).toBe(true);
	});

	it("ignores malformed files rather than failing open", () => {
		writeFileSync(productSettingsPath(home), "{not json");
		expect(loadAutoModeConfig(home).environment).toEqual(defaultEnvironment());
	});

	it("drops non-string environment entries", () => {
		writeUserSettings({ autoMode: { environment: ["real rule", 42, null, "  "] } });
		expect(loadAutoModeConfig(home).environment).toEqual(["real rule"]);
	});

	it("reports a skipped malformed file instead of staying silent about it", () => {
		writeFileSync(productSettingsPath(home), "{not json");
		const { diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("invalid JSON"))).toBe(true);
	});

	it("loads the rule-list extras with $defaults stripped (CC 2.1.233 wizard schema)", () => {
		// The exact shape CC's /auto-mode-setup writes: $defaults first, extras after.
		writeUserSettings({
			autoMode: {
				allow: ["$defaults", "Bash(git-internal add:*) in ~/ml/repo", "Bash(git-internal commit:*) in ~/ml/repo"],
				soft_deny: ["$defaults", "Bash(git add *) when staging internal-only paths"],
				hard_deny: ["$defaults"],
			},
		});
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.allow).toEqual([
			"Bash(git-internal add:*) in ~/ml/repo",
			"Bash(git-internal commit:*) in ~/ml/repo",
		]);
		expect(config.softDeny).toEqual(["Bash(git add *) when staging internal-only paths"]);
		expect(config.hardDeny).toEqual([]);
		// Known keys again — no unknown-key or retirement diagnostics.
		expect(diagnostics.some((line) => line.includes("hard_deny"))).toBe(false);
	});

	it("notes that rule lists omitting $defaults still only append", () => {
		// A user must never believe leaving out "$defaults" disabled the built-ins:
		// the lists are append-only, the embedded ruleset always applies.
		writeUserSettings({ autoMode: { soft_deny: ["mine only"] } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.softDeny).toEqual(["mine only"]);
		expect(diagnostics.some((line) => line.includes("soft_deny") && line.includes("only append"))).toBe(true);
	});

	it("drops non-string rule-list entries and reports mistyped lists", () => {
		writeUserSettings({ autoMode: { allow: ["real", 7, "  "], hard_deny: "not a list" } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.allow).toEqual(["real"]);
		expect(config.hardDeny).toEqual([]);
		expect(diagnostics.some((line) => line.includes("hard_deny must be an array"))).toBe(true);
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
		expect(config.environment).toEqual(defaultEnvironment());
	});

	it("warns when environment omits $defaults AND drops built-in slots", () => {
		writeUserSettings({ autoMode: { environment: ["only my slot"] } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics.some((line) => line.includes("REPLACES the built-in environment"))).toBe(true);
		expect(config.environment).toEqual(["only my slot"]);
	});

	it("does not warn on a full slot replacement — the wizard's normal output", () => {
		// Every built-in slot restated (values edited or not), no "$defaults":
		// exactly what /auto-mode setup and CC's own wizard write.
		writeUserSettings({ autoMode: { environment: [...defaultEnvironment(), "**Extra slot**: added"] } });
		const { diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(diagnostics).toEqual([]);
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

	it("reads permissions.allow from the product's settings for the setup audit", () => {
		// The product's side is the removable set; a borrowed user file (none here)
		// is the warn set, read separately.
		writeUserSettings({ permissions: { allow: ["Bash(*)", "Read"] } });
		expect(productPermissionAllow(home)).toEqual(["Bash(*)", "Read"]);
	});

	it("returns an empty allow list when a settings file is absent or malformed", () => {
		expect(borrowedUserPermissionAllow(home)).toEqual([]);
		expect(productPermissionAllow(home)).toEqual([]);
		writeFileSync(productSettingsPath(home), "{not json");
		expect(productPermissionAllow(home)).toEqual([]);
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

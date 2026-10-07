import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	autoModeSettingsPaths,
	claudeUserPermissionAllow,
	loadAutoModeConfig,
	loadAutoModeConfigWithDiagnostics,
	oneCodePermissionAllow,
	persistClassifierModel,
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
const writeOneCodeSettings = (data: unknown) => {
	mkdirSync(join(home, ".onecode"), { recursive: true });
	writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify(data));
};

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

	it("reads classifierModel and its stamp from One Code's settings", () => {
		writeUserSettings({ autoMode: { classifyAllShell: true } });
		writeOneCodeSettings({ autoMode: { classifierModel: "anthropic/claude-haiku-4-5", classifierModelSetFor: "anthropic" } });
		const config = loadAutoModeConfig(home);
		expect(config.classifyAllShell).toBe(true);
		expect(config.classifierModel).toBe("anthropic/claude-haiku-4-5");
		expect(config.classifierModelSetFor).toBe("anthropic");
	});

	it("never reads classifierModel from Claude Code's settings, and says so", () => {
		writeUserSettings({ autoMode: { classifierModel: "opencode/gemini-3.7-flash" } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.classifierModel).toBeUndefined();
		expect(diagnostics.some((line) => line.includes("classifierModel is ignored here") && line.includes("/auto-mode model"))).toBe(true);
	});

	it("persists and clears classifierModel without touching other keys", () => {
		writeOneCodeSettings({ autoMode: { environment: ["x"] }, other: 1 });
		persistClassifierModel("openai/gpt-6-sol", home, "openai");
		expect(loadAutoModeConfig(home)).toMatchObject({ classifierModel: "openai/gpt-6-sol", classifierModelSetFor: "openai" });
		persistClassifierModel(undefined, home);
		const saved = JSON.parse(readFileSync(join(home, ".onecode", "settings.json"), "utf8"));
		expect(saved).toEqual({ autoMode: { environment: ["x"] }, other: 1 });
	});

	it("flags a classifierModel that is not a model spec", () => {
		writeOneCodeSettings({ autoMode: { classifierModel: 42 } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.classifierModel).toBeUndefined();
		expect(diagnostics.some((line) => line.includes("autoMode.classifierModel must be"))).toBe(true);
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
		expect(config.environment).toEqual(DEFAULT_ENVIRONMENT);
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
		writeUserSettings({ autoMode: { environment: [...DEFAULT_ENVIRONMENT, "**Extra slot**: added"] } });
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

	it("reads permissions.allow from each side for the setup audit split", () => {
		// The audit warns about the .claude side and offers to remove the one-code
		// side; a rule in BOTH must be seen by both readers so the still-live
		// .claude copy is never silently left behind.
		writeUserSettings({ permissions: { allow: ["Bash(git status)", "Bash(*)"] } });
		writeOneCodeSettings({ permissions: { allow: ["Bash(*)", "Read"] } });
		expect(claudeUserPermissionAllow(home)).toEqual(["Bash(git status)", "Bash(*)"]);
		expect(oneCodePermissionAllow(home)).toEqual(["Bash(*)", "Read"]);
		// "Bash(*)" is in both — it lands in the removable set AND the warn set.
	});

	it("returns an empty allow list when a settings file is absent or malformed", () => {
		expect(claudeUserPermissionAllow(home)).toEqual([]);
		mkdirSync(join(home, ".onecode"), { recursive: true });
		writeFileSync(join(home, ".onecode", "settings.json"), "{not json");
		expect(oneCodePermissionAllow(home)).toEqual([]);
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

/**
 * Auto mode's configuration with One Code's source provider on: the
 * Claude Code-schema keys are also read from Claude Code's user settings
 * (`~/.claude/settings.json`), while One Code's own keys (`classifierModel`
 * and its stamp) come only from `~/.onecode`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	borrowedUserPermissionAllow,
	loadAutoModeConfig,
	loadAutoModeConfigWithDiagnostics,
	oneCodePermissionAllow,
} from "../../extensions/auto-mode/config.ts";
import { defaultEnvironment } from "../../extensions/auto-mode/classifier-prompt.ts";
import { tempHome } from "../../test/unit/helpers/temp-home.ts";

let home: string;

beforeEach(() => {
	home = tempHome("cc-automode-").home;
	mkdirSync(join(home, ".claude"), { recursive: true });
});

const writeClaudeSettings = (data: unknown) => writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(data));
const writeOneCodeSettings = (data: unknown) => {
	mkdirSync(join(home, ".onecode"), { recursive: true });
	writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify(data));
};

describe("auto mode's configuration from Claude Code's settings", () => {
	it("splices Claude Code's environment entries around the defaults", () => {
		writeClaudeSettings({ autoMode: { environment: ["$defaults", "Source control: github.example.com/acme"] } });
		const config = loadAutoModeConfig(home);
		expect(config.environment).toContain("Source control: github.example.com/acme");
		expect(config.environment.length).toBe(defaultEnvironment().length + 1);
	});

	it("reads classifierModel and its stamp from One Code's settings, other keys from Claude Code's too", () => {
		writeClaudeSettings({ autoMode: { classifyAllShell: true } });
		writeOneCodeSettings({ autoMode: { classifierModel: "anthropic/claude-haiku-4-5", classifierModelSetFor: "anthropic" } });
		const config = loadAutoModeConfig(home);
		expect(config.classifyAllShell).toBe(true);
		expect(config.classifierModel).toBe("anthropic/claude-haiku-4-5");
		expect(config.classifierModelSetFor).toBe("anthropic");
	});

	it("never reads classifierModel from Claude Code's settings, and says so", () => {
		writeClaudeSettings({ autoMode: { classifierModel: "opencode/gemini-3.7-flash" } });
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.classifierModel).toBeUndefined();
		expect(diagnostics.some((line) => line.includes("classifierModel is ignored here") && line.includes("/auto-mode model"))).toBe(true);
	});

	it("ignores a malformed Claude Code settings file rather than failing open, and reports it", () => {
		writeFileSync(join(home, ".claude", "settings.json"), "{not json");
		const { config, diagnostics } = loadAutoModeConfigWithDiagnostics(home);
		expect(config.environment).toEqual(defaultEnvironment());
		expect(diagnostics.some((line) => line.includes("invalid JSON"))).toBe(true);
	});

	it("reads permissions.allow from each side for the setup audit split", () => {
		// The audit warns about the .claude side and offers to remove the one-code
		// side; a rule in BOTH must be seen by both readers so the still-live
		// .claude copy is never silently left behind.
		writeClaudeSettings({ permissions: { allow: ["Bash(git status)", "Bash(*)"] } });
		writeOneCodeSettings({ permissions: { allow: ["Bash(*)", "Read"] } });
		expect(borrowedUserPermissionAllow(home)).toEqual(["Bash(git status)", "Bash(*)"]);
		expect(oneCodePermissionAllow(home)).toEqual(["Bash(*)", "Read"]);
		// "Bash(*)" is in both — it lands in the removable set AND the warn set.
	});
});

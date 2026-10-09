import { describe, expect, it } from "vitest";
import { managedSettingsPaths } from "../../extensions/lib/claude-settings.ts";

describe("managedSettingsPaths", () => {
	// Claude Code reads managed settings and managed instructions from one root
	// per platform (lib/paths.ts claudeManagedDir); on Windows that is
	// C:\Program Files\ClaudeCode, not C:\ProgramData\ClaudeCode.
	it("reads managed settings from the same root as the managed instructions", () => {
		expect(managedSettingsPaths("darwin")).toEqual(["/Library/Application Support/ClaudeCode/managed-settings.json"]);
		expect(managedSettingsPaths("win32")).toEqual(["C:\\Program Files\\ClaudeCode\\managed-settings.json"]);
		expect(managedSettingsPaths("linux")).toEqual(["/etc/claude-code/managed-settings.json"]);
	});
});

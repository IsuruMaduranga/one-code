/**
 * Hook settings with One Code's source provider on: Claude Code's user,
 * managed, project and local settings files, collected in that order. The
 * base's parsing and caching: test/unit/hooks.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookSettingsPaths, loadHookSettings, resetHookSettingsCache } from "../../extensions/safety/hooks/settings.ts";

describe("hook settings in Claude Code's files", () => {
	let root: string;
	let claudeDir: string;
	let cwd: string;

	beforeEach(() => {
		resetHookSettingsCache();
		root = mkdtempSync(join(tmpdir(), "cc-hooks-settings-"));
		claudeDir = join(root, "home", ".claude");
		cwd = join(root, "project");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(join(cwd, ".claude"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const hooksJson = (command: string) => ({
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
	});

	it("loads user, project, and local scopes in order", () => {
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(hooksJson("user-hook")));
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(hooksJson("project-hook")));
		writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify(hooksJson("local-hook")));
		const loaded = loadHookSettings(cwd, join(claudeDir, ".."));
		expect(loaded.sources.map((s) => s.scope)).toEqual(["user", "project", "local"]);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("names all four candidate paths", () => {
		const paths = hookSettingsPaths("/p", "/h");
		expect(paths.map((p) => p.scope)).toEqual(["user", "managed", "project", "local"]);
	});
});

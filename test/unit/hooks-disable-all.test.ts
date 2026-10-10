import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { loadHookSettings, resetHookSettingsCache } from "../../extensions/hooks/settings.ts";

const fixture = vi.hoisted(() => ({ managedPath: "" }));
vi.mock("../../extensions/lib/claude-settings.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/lib/claude-settings.ts")>()),
	managedSettingsPaths: () => [fixture.managedPath],
}));

describe("hook settings: disableAllHooks", () => {
	let root: string;
	let claudeDir: string;
	let cwd: string;
	let paths: Record<"user" | "managed" | "project" | "local", string>;

	function write(scope: keyof typeof paths, disableAllHooks?: unknown, withHooks = true): void {
		writeFileSync(paths[scope], JSON.stringify({
			...(disableAllHooks !== undefined && { disableAllHooks }),
			...(withHooks && { hooks: { Stop: [{ hooks: [{ type: "command", command: `${scope}-hook` }] }] } }),
		}));
	}

	beforeEach(() => {
		resetConfigModeForTest("claude-compatible");
		resetHookSettingsCache();
		root = mkdtempSync(join(tmpdir(), "hooks-disable-all-"));
		claudeDir = join(root, "home", ".claude");
		cwd = join(root, "project");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		fixture.managedPath = join(root, "managed-settings.json");
		paths = {
			user: join(claudeDir, "settings.json"),
			managed: fixture.managedPath,
			project: join(cwd, ".claude", "settings.json"),
			local: join(cwd, ".claude", "settings.local.json"),
		};
		for (const scope of Object.keys(paths) as Array<keyof typeof paths>) write(scope);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		resetHookSettingsCache();
		resetConfigModeForTest();
	});

	it("preserves the existing source collection order when hooks are enabled", () => {
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["user", "managed", "project", "local"]);
		expect(loaded).not.toHaveProperty("disabled");
	});

	it("a user disable preserves only managed hooks", () => {
		write("user", true);
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["managed"]);
		expect(loaded).toHaveProperty("disabled", "unmanaged");
	});

	// A cloned repository must not switch off the user's own guard hooks.
	it.each(["project", "local"] as const)("a %s disable drops only the repository's own hooks", (scope) => {
		write(scope, true);
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["user", "managed"]);
		expect(loaded).not.toHaveProperty("disabled");
	});

	it("managed true disables every configured source despite project and local false", () => {
		write("managed", true);
		write("project", false);
		write("local", false);
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources).toEqual([]);
		expect(loaded).toHaveProperty("disabled", "all");
	});

	it("managed false overrides a non-managed true without changing source order", () => {
		write("local", true);
		write("managed", false);
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["user", "managed", "project", "local"]);
		expect(loaded).not.toHaveProperty("disabled");
	});

	it("project false does not re-enable hooks a user disable turned off", () => {
		write("user", true);
		write("project", false);
		write("local", false);
		expect(loadHookSettings(claudeDir, cwd)).toHaveProperty("disabled", "unmanaged");
	});

	it("local true overrides project false for the repository's own hooks", () => {
		write("project", false);
		write("local", true);
		expect(loadHookSettings(claudeDir, cwd).sources.map((source) => source.scope)).toEqual(["user", "managed"]);
	});

	it("reads disabling flags from settings files without a hooks block", () => {
		write("user", true, false);
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["managed"]);
		expect(loaded).toHaveProperty("disabled", "unmanaged");
		write("user", undefined, false);
		write("local", true, false);
		resetHookSettingsCache();
		expect(loadHookSettings(claudeDir, cwd).sources.map((source) => source.scope)).toEqual(["managed"]);
	});

	it("retains disabling flags across cached reads and reloads them after mtime changes", () => {
		write("user", true);
		utimesSync(paths.user, new Date(1000000), new Date(1000000));
		expect(loadHookSettings(claudeDir, cwd)).toHaveProperty("disabled", "unmanaged");
		expect(loadHookSettings(claudeDir, cwd)).toHaveProperty("disabled", "unmanaged");
		write("user", false);
		utimesSync(paths.user, new Date(2000000), new Date(2000000));
		expect(loadHookSettings(claudeDir, cwd)).not.toHaveProperty("disabled");
	});

	it("drops a disabling flag when its settings file is deleted", () => {
		write("managed", true);
		expect(loadHookSettings(claudeDir, cwd)).toHaveProperty("disabled", "all");
		rmSync(paths.managed);
		expect(loadHookSettings(claudeDir, cwd).sources.map((source) => source.scope)).toEqual(["user", "project", "local"]);
		expect(loadHookSettings(claudeDir, cwd)).not.toHaveProperty("disabled");
	});

	it("ignores a non-boolean disabling flag rather than overwriting a valid lower-priority flag", () => {
		write("user", true);
		write("local", "false");
		expect(loadHookSettings(claudeDir, cwd)).toHaveProperty("disabled", "unmanaged");
	});
});

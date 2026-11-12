/**
 * `disableAllHooks` across the settings ladder (safety/hooks/settings.ts):
 * managed policy outranks every file, a user's flag leaves managed hooks
 * running, and a repository's flag reaches only the repository's own hooks.
 * The rules read the ladder's roles, so they run over a test source provider
 * with a whole borrowed family (helpers/settings-files.ts) on any profile.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHookSettings, resetHookSettingsCache } from "../../extensions/safety/hooks/settings.ts";
import { borrowedLadderPaths, type LadderPaths, useBorrowedLadder } from "./helpers/settings-files.ts";

describe("hook settings: disableAllHooks", () => {
	useBorrowedLadder();

	let root: string;
	let home: string;
	let cwd: string;
	let paths: LadderPaths;

	function write(scope: keyof LadderPaths, disableAllHooks?: unknown, withHooks = true): void {
		writeFileSync(paths[scope], JSON.stringify({
			...(disableAllHooks !== undefined && { disableAllHooks }),
			...(withHooks && { hooks: { Stop: [{ hooks: [{ type: "command", command: `${scope}-hook` }] }] } }),
		}));
	}

	const scopes = () => loadHookSettings(cwd, home).sources.map((source) => source.scope);

	beforeEach(() => {
		resetHookSettingsCache();
		root = mkdtempSync(join(tmpdir(), "hooks-disable-all-"));
		home = join(root, "home");
		cwd = join(root, "project");
		paths = borrowedLadderPaths(cwd, home);
		for (const scope of Object.keys(paths) as Array<keyof LadderPaths>) {
			mkdirSync(dirname(paths[scope]), { recursive: true });
			write(scope);
		}
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		resetHookSettingsCache();
	});

	it("collects the user's hooks, then managed, then the repository's, when hooks are enabled", () => {
		const loaded = loadHookSettings(cwd, home);
		expect(loaded.sources.map((source) => [source.scope, source.path])).toEqual([
			["user", paths.user],
			["managed", paths.managed],
			["project", paths.project],
			["local", paths.local],
		]);
		expect(loaded).not.toHaveProperty("disabled");
	});

	it("a user disable preserves only managed hooks", () => {
		write("user", true);
		const loaded = loadHookSettings(cwd, home);
		expect(loaded.sources.map((source) => [source.scope, source.path])).toEqual([["managed", paths.managed]]);
		expect(loaded).toHaveProperty("disabled", "unmanaged");
	});

	// A cloned repository must not switch off the user's own guard hooks.
	it.each(["project", "local"] as const)("a %s disable drops only the repository's own hooks", (scope) => {
		write(scope, true);
		const loaded = loadHookSettings(cwd, home);
		expect(loaded.sources.map((source) => [source.scope, source.path])).toEqual([
			["user", paths.user],
			["managed", paths.managed],
		]);
		expect(loaded).not.toHaveProperty("disabled");
	});

	it("managed true disables every configured source despite project and local false", () => {
		write("managed", true);
		write("project", false);
		write("local", false);
		const loaded = loadHookSettings(cwd, home);
		expect(loaded.sources).toEqual([]);
		expect(loaded).toHaveProperty("disabled", "all");
	});

	it("managed false overrides a non-managed true without changing source order", () => {
		write("local", true);
		write("managed", false);
		expect(scopes()).toEqual(["user", "managed", "project", "local"]);
		expect(loadHookSettings(cwd, home)).not.toHaveProperty("disabled");
	});

	it("managed false overrides a user disable", () => {
		write("user", true);
		write("managed", false);
		expect(scopes()).toEqual(["user", "managed", "project", "local"]);
		expect(loadHookSettings(cwd, home)).not.toHaveProperty("disabled");
	});

	it("project false does not re-enable hooks a user disable turned off", () => {
		write("user", true);
		write("project", false);
		write("local", false);
		expect(loadHookSettings(cwd, home)).toHaveProperty("disabled", "unmanaged");
		expect(scopes()).toEqual(["managed"]);
	});

	it("local true overrides project false for the repository's own hooks", () => {
		write("project", false);
		write("local", true);
		expect(scopes()).toEqual(["user", "managed"]);
	});

	it("reads disabling flags from settings files without a hooks block", () => {
		write("user", true, false);
		const loaded = loadHookSettings(cwd, home);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["managed"]);
		expect(loaded).toHaveProperty("disabled", "unmanaged");
		write("user", undefined, false);
		write("local", true, false);
		resetHookSettingsCache();
		expect(scopes()).toEqual(["managed"]);
	});

	it("retains disabling flags across cached reads and reloads them after mtime changes", () => {
		write("user", true);
		utimesSync(paths.user, new Date(1000000), new Date(1000000));
		expect(loadHookSettings(cwd, home)).toHaveProperty("disabled", "unmanaged");
		expect(loadHookSettings(cwd, home)).toHaveProperty("disabled", "unmanaged");
		write("user", false);
		utimesSync(paths.user, new Date(2000000), new Date(2000000));
		expect(loadHookSettings(cwd, home)).not.toHaveProperty("disabled");
	});

	it("drops a disabling flag when its settings file is deleted", () => {
		write("managed", true);
		expect(loadHookSettings(cwd, home)).toHaveProperty("disabled", "all");
		rmSync(paths.managed);
		expect(scopes()).toEqual(["user", "project", "local"]);
		expect(loadHookSettings(cwd, home)).not.toHaveProperty("disabled");
	});

	it("ignores a non-boolean disabling flag rather than overwriting a valid lower-priority flag", () => {
		write("user", true);
		write("local", "false");
		expect(loadHookSettings(cwd, home)).toHaveProperty("disabled", "unmanaged");
	});
});

/**
 * How the base merges permission settings over the files One Code's source
 * provider adds: Claude Code's user file (the primary one) and the
 * repository's `.claude/settings.json` and `settings.local.json`, whose
 * allow rules wait for consent and which may not pick the modes a
 * repository may not grant itself. The profile-independent cases are in
 * test/unit/settings.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSlug } from "../../extensions/lib/memory.ts";
import { loadPermissionSettings } from "../../extensions/permissions/settings.ts";

let dir: string;
let home: string;
let cwd: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cc-settings-"));
	home = join(dir, "home");
	cwd = join(dir, "project");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(cwd, ".claude"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));

describe("loadPermissionSettings over Claude Code's settings files", () => {
	it("merges user, project, and local files with local defaultMode winning", () => {
		write(join(home, ".claude", "settings.json"), {
			permissions: { allow: ["Bash(ls:*)"], defaultMode: "default" },
		});
		write(join(cwd, ".claude", "settings.json"), {
			permissions: { allow: ["Read"], deny: ["Bash(rm -rf:*)"], defaultMode: "acceptEdits" },
		});
		write(join(cwd, ".claude", "settings.local.json"), {
			permissions: { ask: ["Bash(git push:*)"] },
		});

		const s = loadPermissionSettings(cwd, home);
		// The repo's own allow rules are held apart for consent (review P10); its
		// deny/ask rules load freely.
		expect(s.allow).toEqual(["Bash(ls:*)"]);
		expect(s.projectAllow).toEqual(["Read"]);
		expect(s.deny).toEqual(["Bash(rm -rf:*)"]);
		expect(s.ask).toEqual(["Bash(git push:*)"]);
		expect(s.defaultMode).toBe("acceptEdits");
	});

	it("accepts Claude Code's manual alias and dontAsk for defaultMode", () => {
		write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: "manual" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("default");
		write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: "dontAsk" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("dontAsk");
	});

	it("accepts auto as a defaultMode from user settings", () => {
		write(join(home, ".claude", "settings.json"), { permissions: { defaultMode: "auto" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("auto");
	});

	it("ignores defaultMode auto from project and local settings", () => {
		// Both files live in the repo, so honouring `auto` there would let a
		// checked-in file put the session into the mode whose classifier contains it.
		for (const file of ["settings.json", "settings.local.json"]) {
			write(join(cwd, ".claude", file), { permissions: { defaultMode: "auto" } });
			expect(loadPermissionSettings(cwd, home).defaultMode, file).toBeUndefined();
			rmSync(join(cwd, ".claude", file));
		}
	});

	it("ignores defaultMode bypassPermissions from project and local settings (2026-09-05 H3)", () => {
		// A cloned repo must not start the session with every check off; only the
		// user's own or a managed file may pick bypass.
		for (const file of ["settings.json", "settings.local.json"]) {
			write(join(cwd, ".claude", file), { permissions: { defaultMode: "bypassPermissions" } });
			expect(loadPermissionSettings(cwd, home).defaultMode, file).toBeUndefined();
			rmSync(join(cwd, ".claude", file));
		}
		write(join(home, ".claude", "settings.json"), { permissions: { defaultMode: "bypassPermissions" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("bypassPermissions");
		// A project file cannot override the user's choice with a refused mode either.
		write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: "bypassPermissions" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("bypassPermissions");
	});

	it("still honours dontAsk and acceptEdits from project settings (they cannot approve more than default)", () => {
		for (const mode of ["dontAsk", "acceptEdits"]) {
			write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: mode } });
			expect(loadPermissionSettings(cwd, home).defaultMode, mode).toBe(mode);
		}
	});

	it("reads disableBypassPermissionsMode from any source, as a restriction", () => {
		expect(loadPermissionSettings(cwd, home).disableBypassPermissionsMode).toBeUndefined();
		write(join(cwd, ".claude", "settings.json"), { permissions: { disableBypassPermissionsMode: "disable" } });
		expect(loadPermissionSettings(cwd, home).disableBypassPermissionsMode).toBe(true);
		write(join(cwd, ".claude", "settings.json"), { permissions: { disableBypassPermissionsMode: "enable" } });
		expect(loadPermissionSettings(cwd, home).disableBypassPermissionsMode).toBeUndefined();
	});

	it("still honours other modes from project settings", () => {
		write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: "plan" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("plan");
	});

	it("does not let a project file downgrade user-set auto to nothing", () => {
		write(join(home, ".claude", "settings.json"), { permissions: { defaultMode: "auto" } });
		write(join(cwd, ".claude", "settings.json"), { permissions: { allow: ["Read"] } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("auto");
	});

	it("merges One Code's own global and per-repo allow files alongside .claude", () => {
		// /allow persists to ~/.onecode (global) and a per-repo file under it — those
		// rules are read back here, never from a write into Claude Code's files.
		write(join(home, ".claude", "settings.json"), { permissions: { allow: ["Bash(ls:*)"] } });
		mkdirSync(join(home, ".onecode"), { recursive: true });
		write(join(home, ".onecode", "settings.json"), { permissions: { allow: ["Read"] } });
		// The per-repo slug is taken from the natively resolved root (macOS TMPDIR sits behind a
		// symlink; Windows TEMP can be an 8.3 short name).
		const projectDir = join(home, ".onecode", "projects", projectSlug(realpathSync.native(cwd)));
		mkdirSync(projectDir, { recursive: true });
		write(join(projectDir, "settings.json"), { permissions: { allow: ["Bash(npm test:*)"] } });

		const s = loadPermissionSettings(cwd, home);
		expect(s.allow).toEqual(expect.arrayContaining(["Bash(ls:*)", "Read", "Bash(npm test:*)"]));
	});

	it("never takes defaultMode from a One Code file", () => {
		// One Code writes only rules to its files; a hand-edited defaultMode there
		// (auto included) must not flip the session — that stays a .claude decision.
		mkdirSync(join(home, ".onecode"), { recursive: true });
		write(join(home, ".onecode", "settings.json"), { permissions: { defaultMode: "auto" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBeUndefined();
	});
	it("reads the block setting from any source, the repository's included (it only tightens)", () => {
		expect(loadPermissionSettings(cwd, home).blockReadsOutsideWorkingDirectories).toBeUndefined();
		write(join(cwd, ".claude", "settings.json"), { permissions: { blockReadsOutsideWorkingDirectories: true } });
		expect(loadPermissionSettings(cwd, home).blockReadsOutsideWorkingDirectories).toBe(true);
	});
});

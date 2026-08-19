import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPermissionSettings, persistAllowRule } from "../../extensions/permissions/settings.ts";

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

describe("loadPermissionSettings", () => {
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
		expect(s.allow).toEqual(["Bash(ls:*)", "Read"]);
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

	it("still honours other modes from project settings", () => {
		write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: "plan" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("plan");
	});

	it("does not let a project file downgrade user-set auto to nothing", () => {
		write(join(home, ".claude", "settings.json"), { permissions: { defaultMode: "auto" } });
		write(join(cwd, ".claude", "settings.json"), { permissions: { allow: ["Read"] } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("auto");
	});

	it("ignores unknown defaultMode values", () => {
		write(join(cwd, ".claude", "settings.json"), { permissions: { defaultMode: "turbo" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBeUndefined();
	});

	it("tolerates missing and malformed files", () => {
		writeFileSync(join(cwd, ".claude", "settings.json"), "{not json");
		const s = loadPermissionSettings(cwd, home);
		expect(s).toEqual({ allow: [], deny: [], ask: [] });
	});

	it("merges One Code's own global and per-repo allow files alongside .claude", () => {
		// /allow persists to ~/.one-code (global) and a per-repo file under it — those
		// rules are read back here, never from a write into Claude Code's files.
		write(join(home, ".claude", "settings.json"), { permissions: { allow: ["Bash(ls:*)"] } });
		mkdirSync(join(home, ".one-code"), { recursive: true });
		write(join(home, ".one-code", "settings.json"), { permissions: { allow: ["Read"] } });
		const projectDir = join(home, ".one-code", "projects", cwd.replace(/[^A-Za-z0-9-]/g, "-"));
		mkdirSync(projectDir, { recursive: true });
		write(join(projectDir, "settings.json"), { permissions: { allow: ["Bash(npm test:*)"] } });

		const s = loadPermissionSettings(cwd, home);
		expect(s.allow).toEqual(expect.arrayContaining(["Bash(ls:*)", "Read", "Bash(npm test:*)"]));
	});

	it("never takes defaultMode from a One Code file", () => {
		// One Code writes only rules to its files; a hand-edited defaultMode there
		// (auto included) must not flip the session — that stays a .claude decision.
		mkdirSync(join(home, ".one-code"), { recursive: true });
		write(join(home, ".one-code", "settings.json"), { permissions: { defaultMode: "auto" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBeUndefined();
	});
});

describe("persistAllowRule", () => {
	it("creates the file and appends without duplicating", () => {
		const target = join(cwd, ".claude", "settings.local.json");
		persistAllowRule("Bash(npm test:*)", target);
		persistAllowRule("Bash(npm test:*)", target);
		persistAllowRule("Read", target);
		const parsed = JSON.parse(readFileSync(target, "utf-8"));
		expect(parsed.permissions.allow).toEqual(["Bash(npm test:*)", "Read"]);
	});

	it("preserves unrelated keys", () => {
		const target = join(cwd, ".claude", "settings.json");
		write(target, { model: "opus", permissions: { deny: ["Bash(sudo:*)"] } });
		persistAllowRule("Read", target);
		const parsed = JSON.parse(readFileSync(target, "utf-8"));
		expect(parsed.model).toBe("opus");
		expect(parsed.permissions.deny).toEqual(["Bash(sudo:*)"]);
		expect(parsed.permissions.allow).toEqual(["Read"]);
	});
});

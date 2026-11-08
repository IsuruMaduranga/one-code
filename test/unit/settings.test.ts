import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { productProjectSettingsPath, productSettingsPath } from "../../extensions/lib/product-settings.ts";
import {
	loadPermissionSettings,
	markOutsideReadPromptSeen,
	outsideReadPromptSeen,
	persistAllowRule,
	persistBlockOutsideReads,
	resolveStartupMode,
} from "../../extensions/permissions/settings.ts";
import { userSettingsPath, useRepositorySettings, writeRepositorySettings, writeUserSettings } from "./helpers/settings-files.ts";
import { tempHome } from "./helpers/temp-home.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	({ home, cwd } = tempHome("cc-settings-"));
	mkdirSync(join(cwd, ".claude"), { recursive: true });
});

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));

describe("loadPermissionSettings", () => {
	// The files are found by role, so these hold for any profile: the primary
	// user file is Claude Code's with a provider that reads it, the product's
	// own without one. The repository's file is in the next block.
	const writeFile = (path: string, data: unknown) => {
		mkdirSync(dirname(path), { recursive: true });
		write(path, data);
	};

	it("takes defaultMode from the primary user file, auto and bypassPermissions included", () => {
		for (const mode of ["auto", "bypassPermissions", "acceptEdits", "plan"]) {
			writeUserSettings(cwd, home, { permissions: { defaultMode: mode } });
			expect(loadPermissionSettings(cwd, home).defaultMode, mode).toBe(mode);
		}
	});

	it("accepts Claude Code's manual alias and dontAsk for defaultMode", () => {
		writeUserSettings(cwd, home, { permissions: { defaultMode: "manual" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("default");
		writeUserSettings(cwd, home, { permissions: { defaultMode: "dontAsk" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("dontAsk");
	});

	it("ignores unknown defaultMode values", () => {
		writeUserSettings(cwd, home, { permissions: { defaultMode: "turbo" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBeUndefined();
	});

	it("tolerates missing and malformed files", () => {
		expect(loadPermissionSettings(cwd, home)).toEqual({ allow: [], projectAllow: [], deny: [], ask: [] });
		const file = userSettingsPath(cwd, home);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "{not json");
		expect(loadPermissionSettings(cwd, home)).toEqual({ allow: [], projectAllow: [], deny: [], ask: [] });
	});

	it("merges the product's own global and per-repo allow files", () => {
		// /allow persists to the product's user file and a per-repo file in its state dir.
		writeFile(productSettingsPath(home), { permissions: { allow: ["Read"], deny: ["Bash(sudo:*)"], ask: ["Bash(git push:*)"] } });
		writeFile(productProjectSettingsPath(cwd, home), { permissions: { allow: ["Bash(npm test:*)"] } });
		const s = loadPermissionSettings(cwd, home);
		expect(s.allow).toEqual(expect.arrayContaining(["Read", "Bash(npm test:*)"]));
		expect(s.allow).toHaveLength(2);
		expect(s.projectAllow).toEqual([]);
		expect(s.deny).toEqual(["Bash(sudo:*)"]);
		expect(s.ask).toEqual(["Bash(git push:*)"]);
	});

	it("never takes defaultMode from the product's per-repo file", () => {
		// The product writes only rules there; a hand-edited defaultMode (auto
		// included) must not flip the session.
		writeFile(productProjectSettingsPath(cwd, home), { permissions: { defaultMode: "auto" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBeUndefined();
	});

	it("reads disableBypassPermissionsMode and blockReadsOutsideWorkingDirectories from the product's per-repo file, as restrictions", () => {
		expect(loadPermissionSettings(cwd, home).disableBypassPermissionsMode).toBeUndefined();
		expect(loadPermissionSettings(cwd, home).blockReadsOutsideWorkingDirectories).toBeUndefined();
		writeFile(productProjectSettingsPath(cwd, home), { permissions: { disableBypassPermissionsMode: "disable", blockReadsOutsideWorkingDirectories: true } });
		expect(loadPermissionSettings(cwd, home).disableBypassPermissionsMode).toBe(true);
		expect(loadPermissionSettings(cwd, home).blockReadsOutsideWorkingDirectories).toBe(true);
	});
});

describe("loadPermissionSettings with a repository settings file", () => {
	// A repository's file is the one a cloned repo controls: its allow rules
	// wait for consent, and it may not pick a mode that approves more than
	// default. Only a source provider lists one; the helper lists one on any
	// profile.
	useRepositorySettings();

	it("holds the repository's allow rules apart for consent, and loads its deny and ask rules", () => {
		writeUserSettings(cwd, home, { permissions: { allow: ["Bash(ls:*)"] } });
		writeRepositorySettings(cwd, home, { permissions: { allow: ["Read"], deny: ["Bash(rm -rf:*)"], ask: ["Bash(git push:*)"] } });
		const s = loadPermissionSettings(cwd, home);
		expect(s.allow).toEqual(["Bash(ls:*)"]);
		expect(s.projectAllow).toEqual(["Read"]);
		expect(s.deny).toEqual(["Bash(rm -rf:*)"]);
		expect(s.ask).toEqual(["Bash(git push:*)"]);
	});

	it("ignores defaultMode auto and bypassPermissions from the repository's file", () => {
		for (const mode of ["auto", "bypassPermissions"]) {
			writeRepositorySettings(cwd, home, { permissions: { defaultMode: mode } });
			expect(loadPermissionSettings(cwd, home).defaultMode, mode).toBeUndefined();
		}
	});

	it("keeps the user's own bypassPermissions or auto when the repository's file names a mode it may not pick", () => {
		for (const mode of ["auto", "bypassPermissions"]) {
			writeUserSettings(cwd, home, { permissions: { defaultMode: mode } });
			writeRepositorySettings(cwd, home, { permissions: { defaultMode: "bypassPermissions" } });
			expect(loadPermissionSettings(cwd, home).defaultMode, mode).toBe(mode);
		}
	});

	it("still honours dontAsk, acceptEdits and plan from the repository's file (none approves more than default)", () => {
		for (const mode of ["dontAsk", "acceptEdits", "plan"]) {
			writeRepositorySettings(cwd, home, { permissions: { defaultMode: mode } });
			expect(loadPermissionSettings(cwd, home).defaultMode, mode).toBe(mode);
		}
	});

	it("reads disableBypassPermissionsMode from the repository's file, as a restriction", () => {
		writeRepositorySettings(cwd, home, { permissions: { disableBypassPermissionsMode: "disable" } });
		expect(loadPermissionSettings(cwd, home).disableBypassPermissionsMode).toBe(true);
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

describe("resolveStartupMode", () => {
	it("takes the first requested mode in Claude Code's precedence order", () => {
		expect(resolveStartupMode(["bypassPermissions", "plan", "auto"], {})).toEqual({ mode: "bypassPermissions", bypassRefused: false });
		expect(resolveStartupMode([undefined, "plan", "auto"], {})).toEqual({ mode: "plan", bypassRefused: false });
		expect(resolveStartupMode([undefined, undefined, "auto"], {})).toEqual({ mode: "auto", bypassRefused: false });
	});

	it("leaves the mode undefined when nothing was requested (a reload keeps the live mode)", () => {
		expect(resolveStartupMode([undefined, undefined, undefined], {})).toEqual({ bypassRefused: false });
	});

	it("skips bypassPermissions when disabled by settings, however it was requested, and falls to the next", () => {
		const disabled = { disableBypassPermissionsMode: true };
		expect(resolveStartupMode(["bypassPermissions", undefined, "acceptEdits"], disabled)).toEqual({ mode: "acceptEdits", bypassRefused: true });
		expect(resolveStartupMode([undefined, "bypassPermissions", undefined], disabled)).toEqual({ bypassRefused: true });
		expect(resolveStartupMode([undefined, undefined, "bypassPermissions"], disabled)).toEqual({ bypassRefused: true });
		expect(resolveStartupMode(["bypassPermissions", "bypassPermissions", "plan"], disabled)).toEqual({ mode: "plan", bypassRefused: true });
		// Not disabled: bypass wins as requested.
		expect(resolveStartupMode(["bypassPermissions", undefined, "plan"], {})).toEqual({ mode: "bypassPermissions", bypassRefused: false });
	});
});

describe("blockReadsOutsideWorkingDirectories and the first outside-read prompt", () => {
	it("persists Block into the given product file, keeping its other keys", () => {
		const file = productSettingsPath(home);
		mkdirSync(dirname(file), { recursive: true });
		write(file, { permissions: { allow: ["Read"] }, theme: "x" });
		persistBlockOutsideReads(file);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		expect(saved).toEqual({ permissions: { allow: ["Read"], blockReadsOutsideWorkingDirectories: true }, theme: "x" });
	});

	it("counts the prompt as answered from the product's flag or Claude Code's ~/.claude.json", () => {
		const oneCode = productSettingsPath(home);
		const claudeJson = join(home, ".claude.json");
		expect(outsideReadPromptSeen(oneCode, [claudeJson])).toBe(false);
		write(claudeJson, { hasSeenAutoModeOutsideReadPrompt: true });
		expect(outsideReadPromptSeen(oneCode, [claudeJson])).toBe(true);
		rmSync(claudeJson);
		markOutsideReadPromptSeen(oneCode);
		expect(outsideReadPromptSeen(oneCode, [claudeJson])).toBe(true);
	});
});

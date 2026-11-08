import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brand } from "../../extensions/lib/brand.mjs";
import { primarySettingsFile, settingsSources } from "../../extensions/lib/claude-settings.ts";
import { productProjectSettingsPath, productSettingsPath } from "../../extensions/lib/product-settings.ts";
import {
	loadPermissionSettings,
	markOutsideReadPromptSeen,
	outsideReadPromptSeen,
	persistAllowRule,
	persistBlockOutsideReads,
	resolveStartupMode,
} from "../../extensions/permissions/settings.ts";

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
	// The files are found by role, so these hold for any profile: the primary
	// user file is Claude Code's with a provider that reads it, the product's
	// own without one. The repository's files, which only a source provider
	// supplies, are covered with that provider's tests.
	const sources = () => settingsSources(cwd, home);
	const primaryFile = () => primarySettingsFile(sources())!.path;
	const writeFile = (path: string, data: unknown) => {
		mkdirSync(dirname(path), { recursive: true });
		write(path, data);
	};

	it("takes defaultMode from the primary user file, auto and bypassPermissions included", () => {
		for (const mode of ["auto", "bypassPermissions", "acceptEdits", "plan"]) {
			writeFile(primaryFile(), { permissions: { defaultMode: mode } });
			expect(loadPermissionSettings(cwd, home).defaultMode, mode).toBe(mode);
		}
	});

	it("accepts Claude Code's manual alias and dontAsk for defaultMode", () => {
		writeFile(primaryFile(), { permissions: { defaultMode: "manual" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("default");
		writeFile(primaryFile(), { permissions: { defaultMode: "dontAsk" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBe("dontAsk");
	});

	it("ignores unknown defaultMode values", () => {
		writeFile(primaryFile(), { permissions: { defaultMode: "turbo" } });
		expect(loadPermissionSettings(cwd, home).defaultMode).toBeUndefined();
	});

	it("tolerates missing and malformed files", () => {
		expect(loadPermissionSettings(cwd, home)).toEqual({ allow: [], projectAllow: [], deny: [], ask: [] });
		mkdirSync(dirname(primaryFile()), { recursive: true });
		writeFileSync(primaryFile(), "{not json");
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
		const file = join(home, brand.stateDir, "settings.json");
		mkdirSync(join(home, brand.stateDir), { recursive: true });
		write(file, { permissions: { allow: ["Read"] }, theme: "x" });
		persistBlockOutsideReads(file);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		expect(saved).toEqual({ permissions: { allow: ["Read"], blockReadsOutsideWorkingDirectories: true }, theme: "x" });
	});

	it("counts the prompt as answered from the product's flag or Claude Code's ~/.claude.json", () => {
		const oneCode = join(home, brand.stateDir, "settings.json");
		const claudeJson = join(home, ".claude.json");
		expect(outsideReadPromptSeen(oneCode, [claudeJson])).toBe(false);
		write(claudeJson, { hasSeenAutoModeOutsideReadPrompt: true });
		expect(outsideReadPromptSeen(oneCode, [claudeJson])).toBe(true);
		rmSync(claudeJson);
		markOutsideReadPromptSeen(oneCode);
		expect(outsideReadPromptSeen(oneCode, [claudeJson])).toBe(true);
	});
});

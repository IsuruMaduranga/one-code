/**
 * The source view's config folders (lib/sources.ts): One Code's provider
 * puts Claude Code's in place of the product's own, independent mode and a
 * profile without a provider keep the product's. The settings ladder a
 * provider shapes, and the safety floor every file of it joins.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { safetyControlWrite } from "../../extensions/auto-mode/safety-floor.ts";
import { settingsSources } from "../../extensions/lib/claude-settings.ts";
import { profileModuleKey, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile.ts";
import { shareModuleForTest } from "../../extensions/lib/shared-module.ts";
import { configDirs, projectConfigDir, type SourceProvider, userConfigDir } from "../../extensions/lib/sources.ts";
import { profile } from "../../profile/index.ts";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sources-"));
});
afterEach(() => {
	setActiveProfileForTest(undefined);
	rmSync(home, { recursive: true, force: true });
});

describe("configDirs", () => {
	it("is Claude Code's with One Code's provider on", () => {
		expect(configDirs(home)).toEqual({ user: join(home, ".claude"), project: ".claude" });
		expect(projectConfigDir("/repo")).toBe(join("/repo", ".claude"));
	});

	it("is the product's own in independent mode", () => {
		resetConfigModeForTest("independent");
		expect(configDirs(home)).toEqual({ user: join(home, ".onecode"), project: ".onecode" });
	});

	it("is the product's own without a provider", () => {
		setActiveProfileForTest(resolveProfile({ ...profile, sources: undefined }, {}, "/profile"));
		expect(userConfigDir(home)).toBe(join(home, ".onecode"));
		expect(projectConfigDir("/repo")).toBe(join("/repo", ".onecode"));
	});
});

describe("the provider outside pi's loader", () => {
	// Settings reads reach the provider, which needs the profile; the hook
	// executor and the shell module run in plain Node children in tests, whose
	// strip-only TypeScript rejects enums and parameter properties.
	it("loads the profile under Node's strip-only TypeScript", () => {
		const sources = pathToFileURL(join(process.cwd(), "extensions", "lib", "sources.ts")).href;
		const script = `import { userConfigDir } from ${JSON.stringify(sources)}; console.log(userConfigDir(${JSON.stringify(home)}));`;
		const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf-8", env: { ...process.env, ONECODE_CONFIG_MODE: "claude-compatible" } });
		expect(run.stderr).toBe("");
		expect(run.stdout.trim()).toBe(join(home, ".claude"));
	});
});

/** A profile whose source provider is `provider`, shared under the module slot a real one would use. */
function useProvider(provider: SourceProvider): void {
	const resolved = resolveProfile({ ...profile, sources: "fixture-sources.ts" }, {}, "/fixture-profile");
	shareModuleForTest(profileModuleKey(resolved.sourcesModule ?? ""), { sources: provider });
	setActiveProfileForTest(resolved);
}

describe("the settings ladder", () => {
	const cwd = "/repo";
	const writes = (path: string) => safetyControlWrite({ toolName: "write", input: { path }, cwd, home });

	it("wraps Claude Code's four kinds of file around One Code's two, Claude Code's user file primary", () => {
		const files = settingsSources(cwd, home);
		expect(files.map((file) => `${file.owner}-${file.scope}`)).toEqual(["borrowed-user", "product-user", "borrowed-project", "borrowed-local", "product-local", "borrowed-managed"]);
		expect(files.filter((file) => file.primary).map((file) => file.path)).toEqual([join(home, ".claude", "settings.json")]);
	});

	it("is One Code's two files alone in independent mode, One Code's user file primary", () => {
		resetConfigModeForTest("independent");
		const files = settingsSources(cwd, home);
		expect(files.map((file) => `${file.owner}-${file.scope}`)).toEqual(["product-user", "product-local"]);
		expect(files[0]).toMatchObject({ path: join(home, ".onecode", "settings.json"), primary: true });
	});

	it("puts every file of One Code's ladder under the safety floor", () => {
		for (const file of settingsSources(cwd, home)) expect(writes(file.path), file.path).toBeDefined();
	});

	it("puts a file another provider adds under the safety floor", () => {
		const extra = join(home, ".other-tool", "config.json");
		expect(writes(extra)).toBeUndefined();
		useProvider({ open: () => ({ settings: (base) => [{ path: extra, scope: "user", owner: "borrowed", primary: true, label: "Other tool settings" }, ...base] }) });
		expect(settingsSources(cwd, home)[0].path).toBe(extra);
		expect(writes(extra)).toBeDefined();
	});
});

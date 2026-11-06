/**
 * The source view's config folders (lib/sources.ts): One Code's provider
 * puts Claude Code's in place of the product's own, independent mode and a
 * profile without a provider keep the product's.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile.ts";
import { configDirs, projectConfigDir, userConfigDir } from "../../extensions/lib/sources.ts";
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

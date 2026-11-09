/**
 * The source view's config folders (lib/sources.ts): One Code's provider
 * puts Claude Code's in place of the product's own, independent mode and a
 * profile without a provider keep the product's. The settings ladder a
 * provider shapes, and the safety floor every file of it joins.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigModeForTest } from "../claude-code/mode.ts";
import { safetyControlWrite } from "../../extensions/permissions/auto-mode/safety-floor.ts";
import { loadPermissionSettings } from "../../extensions/lib/rules/settings.ts";
import { settingsSources } from "../../extensions/lib/claude-settings.ts";
import { instructionFileNames, instructionTargets, openInstructions } from "../../extensions/lib/instructions.ts";
import { autoModeSettingsFiles } from "../../extensions/lib/rules/auto-mode-config.ts";
import { isClaudeLocation } from "../../extensions/lib/paths.ts";
import { INIT_PROMPT, initPrompt } from "../text/init/prompt.ts";
import { profileModuleKey, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile.ts";
import { shareModuleForTest } from "../../extensions/lib/shared-module.ts";
import { configDirs, projectConfigDir, type SourceProvider, userConfigDir } from "../../extensions/lib/sources.ts";
import { profile } from "../index.ts";
import { tempHome } from "../../test/unit/helpers/temp-home.ts";

let home: string;
beforeEach(() => {
	home = tempHome("sources-").home;
});
afterEach(() => {
	setActiveProfileForTest(undefined);
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

	it("treats a file the provider marks as the repository's as the repository's, whoever owns it", () => {
		const checkedIn = join(home, "repo", ".product", "settings.json");
		mkdirSync(join(home, "repo", ".product"), { recursive: true });
		writeFileSync(checkedIn, JSON.stringify({ permissions: { allow: ["Bash(make:*)"], defaultMode: "bypassPermissions" } }));
		useProvider({ open: () => ({ settings: (base) => [...base, { path: checkedIn, scope: "project", owner: "product", repo: true, label: "product project settings" }] }) });
		const merged = loadPermissionSettings(join(home, "repo"), home);
		expect(merged.projectAllow).toEqual(["Bash(make:*)"]);
		expect(merged.allow).toEqual([]);
		expect(merged.defaultMode).toBeUndefined();
	});

	it("marks the product's user file primary by role, so a provider may copy the base's entries", () => {
		useProvider({ open: () => ({ settings: (base) => base.map((file) => ({ ...file, label: `${file.label}!` })) }) });
		expect(settingsSources(cwd, home).find((file) => file.primary)?.path).toBe(join(home, ".onecode", "settings.json"));
	});

	it("never makes a repository's file primary, nor reads auto-mode settings from one", () => {
		const repoUser = join(home, "repo", ".tool", "settings.json");
		useProvider({ open: () => ({ settings: (base) => [{ path: repoUser, scope: "user", owner: "borrowed", repo: true, primary: true, label: "repo file" }, ...base] }) });
		const files = settingsSources(cwd, home);
		expect(files.find((file) => file.primary)?.path).toBe(join(home, ".onecode", "settings.json"));
		expect(autoModeSettingsFiles(home).map((file) => file.path)).not.toContain(repoUser);
	});

	it("puts another provider's state files under the safety floor", () => {
		const state = join(home, ".other-tool.json");
		expect(writes(state)).toBeUndefined();
		useProvider({ open: () => ({ protectedFiles: [{ path: state, label: "Other tool state" }] }) });
		expect(writes(state)).toBeDefined();
	});
});

describe("the instruction files a user writes", () => {
	it("are CLAUDE.md with One Code's provider on", () => {
		expect(instructionTargets(home)).toEqual({ project: "CLAUDE.md", user: join(home, ".claude", "CLAUDE.md") });
		expect(instructionFileNames(home)).toEqual(["CLAUDE.md"]);
	});

	it("are AGENTS.md and the global ONECODE.md in independent mode", () => {
		resetConfigModeForTest("independent");
		expect(instructionTargets(home)).toEqual({ project: "AGENTS.md", user: join(home, ".onecode", "ONECODE.md") });
		expect(instructionFileNames(home)).toEqual(["AGENTS.md", "ONECODE.md"]);
	});

	it("give /init its target: the CLAUDE.md prompt unchanged, the AGENTS.md one without folding an AGENTS.md in", () => {
		expect(initPrompt("CLAUDE.md")).toBe(INIT_PROMPT);
		const agents = initPrompt("AGENTS.md");
		expect(agents).not.toContain("CLAUDE.md");
		expect(agents.startsWith("Please analyze this codebase and create an AGENTS.md file,")).toBe(true);
		expect(agents).toContain("Copilot rules (in .github/copilot-instructions.md), make sure");
		expect(agents).toContain("```\n# AGENTS.md\n");
	});
});

describe("independent mode's reads", () => {
	it("keep ~/.claude.json out", () => {
		expect(isClaudeLocation(join(home, ".claude.json"), join(home, ".claude"))).toBe(true);
		expect(isClaudeLocation(join(home, "claude.json"), join(home, ".claude"))).toBe(false);
	});

	it("load an approved AGENTS.md import from outside the project, and ask for it first", () => {
		resetConfigModeForTest("independent");
		const project = join(home, "proj");
		mkdirSync(join(home, "shared"), { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(home, "shared", "rules.md"), "SHARED RULE\n");
		writeFileSync(join(project, "AGENTS.md"), "@../shared/rules.md\n");
		const instructions = openInstructions(home, undefined);
		expect(instructions.externalIncludes({ cwd: project })).toEqual([realpathSync(join(home, "shared", "rules.md"))]);
		expect(JSON.stringify(instructions.sections({ cwd: project, includeExternal: false }).contextFiles)).not.toContain("SHARED RULE");
		expect(JSON.stringify(instructions.sections({ cwd: project, includeExternal: true }).contextFiles)).toContain("SHARED RULE");
	});

	it("leave an AGENTS.md that Claude Code's rule skips out of the approval question", () => {
		const project = join(home, "proj");
		mkdirSync(join(home, "shared"), { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(home, "shared", "rules.md"), "SHARED RULE\n");
		writeFileSync(join(project, "AGENTS.md"), "@../shared/rules.md\n");
		writeFileSync(join(project, "CLAUDE.md"), "claude rules\n");
		expect(openInstructions(home, undefined).externalIncludes({ cwd: project })).toEqual([]);
	});
});

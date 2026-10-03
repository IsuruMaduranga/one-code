import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoModeSettingsPaths } from "../../extensions/auto-mode/config.ts";
import { readLoopFile } from "../../extensions/background/loop-fire.ts";
import { claudeResourcePaths } from "../../extensions/claude-compat/index.ts";
import { hookSettingsPaths } from "../../extensions/hooks/settings.ts";
import { readSettingsEnv } from "../../extensions/lib/claude-settings.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { defaultDiscoverRoots, discoverPlugins, invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { promptTemplateFiles, scanSkills } from "../../extensions/lib/skill-scan.ts";
import { configPaths } from "../../extensions/mcp/config.ts";
import { buildMemoryEntries } from "../../extensions/memory/entries.ts";
import { loadPermissionSettings } from "../../extensions/permissions/settings.ts";
import { agentDirs } from "../../extensions/subagents/agents.ts";
import { workflowDirs } from "../../extensions/workflow/saved-workflows.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "config-sources-"));
}
function touch(path: string, text = "x"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

// A fresh home and project per test, with One Code's state dir inside the home.
let home: string;
let cwd: string;
beforeEach(() => {
	home = scratch();
	cwd = scratch();
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
});
afterEach(() => vi.unstubAllEnvs());

describe("independent mode reads no Claude Code folder for skills, commands, agents and workflows", () => {
	it("claude-compat feeds pi only the cross-tool skills and the .onecode commands", () => {
		for (const dir of [join(home, ".claude", "skills"), join(cwd, ".claude", "skills"), join(home, ".agents", "skills"), join(cwd, ".agents", "skills")]) mkdirSync(dir, { recursive: true });
		for (const dir of [join(home, ".claude", "commands"), join(cwd, ".onecode", "commands"), join(home, ".onecode", "commands")]) mkdirSync(dir, { recursive: true });
		const compatible = claudeResourcePaths(cwd, home, join(home, ".claude"));
		expect(compatible.skillPaths).toContain(join(home, ".claude", "skills"));
		expect(compatible.promptPaths).toEqual([join(home, ".claude", "commands")]);
		resetConfigModeForTest("independent");
		const independent = claudeResourcePaths(cwd, home, join(home, ".claude"));
		expect(independent.skillPaths).toEqual([join(home, ".agents", "skills"), join(cwd, ".agents", "skills")]);
		expect(independent.promptPaths).toEqual([join(home, ".onecode", "commands"), join(cwd, ".onecode", "commands")]);
	});

	it("moves agents, workflows, prompt templates and loop.md to .onecode", () => {
		resetConfigModeForTest("independent");
		expect(agentDirs(cwd, home)).toEqual([join(home, ".onecode", "agents"), join(cwd, ".onecode", "agents")]);
		expect(workflowDirs(cwd, home)).toEqual({ project: join(cwd, ".onecode", "workflows"), user: join(home, ".onecode", "workflows") });
		touch(join(cwd, ".claude", "commands", "cc.md"));
		touch(join(cwd, ".onecode", "commands", "oc.md"));
		expect(promptTemplateFiles(cwd, home, join(home, "agent")).map((f) => f.name)).toEqual(["oc"]);
		touch(join(cwd, ".claude", "loop.md"), "claude tasks");
		expect(readLoopFile(cwd, home)).toBeNull();
		touch(join(cwd, ".onecode", "loop.md"), "own tasks");
		expect(readLoopFile(cwd, home)?.content).toBe("own tasks");
	});

	it("scans no .claude skills", () => {
		resetConfigModeForTest("independent");
		touch(join(home, ".claude", "skills", "cc", "SKILL.md"));
		touch(join(cwd, ".agents", "skills", "shared", "SKILL.md"));
		expect(scanSkills(cwd, home, join(home, "agent"), []).map((s) => s.name)).toEqual(["shared"]);
	});

	it("skips Claude Code's installed plugins", () => {
		invalidatePluginsCache();
		expect(defaultDiscoverRoots(join(home, "agent"), cwd, home).claudePluginsDir).toBe(join(home, ".claude", "plugins"));
		resetConfigModeForTest("independent");
		expect(defaultDiscoverRoots(join(home, "agent"), cwd, home).claudePluginsDir).toBeUndefined();
		expect(discoverPlugins(defaultDiscoverRoots(join(home, "agent"), cwd, home)).plugins).toEqual([]);
	});
});

describe("independent mode reads settings from One Code's files only", () => {
	it("permissions: rules and defaultMode from One Code's user file, nothing from .claude or managed", () => {
		touch(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(cc:*)"], defaultMode: "plan" } }));
		touch(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(x)"] } }));
		touch(join(home, ".onecode", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(oc:*)"], defaultMode: "acceptEdits" } }));
		const compatible = loadPermissionSettings(cwd, home);
		expect(compatible.allow).toEqual(["Bash(cc:*)", "Bash(oc:*)"]);
		expect(compatible.deny).toEqual(["Read(x)"]);
		expect(compatible.defaultMode).toBe("plan");
		resetConfigModeForTest("independent");
		const independent = loadPermissionSettings(cwd, home);
		expect(independent.allow).toEqual(["Bash(oc:*)"]);
		expect(independent.deny).toEqual([]);
		expect(independent.defaultMode).toBe("acceptEdits");
	});

	it("auto mode, hooks, MCP files and the env block", () => {
		const ocUser = join(home, ".onecode", "settings.json");
		touch(join(cwd, ".mcp.json"), "{}");
		touch(join(home, ".claude", "settings.json"), JSON.stringify({ env: { A: "claude" } }));
		touch(ocUser, JSON.stringify({ env: { A: "onecode" } }));
		expect(configPaths(cwd, home)).toContain(join(cwd, ".mcp.json"));
		expect(readSettingsEnv(home)).toEqual({ A: "claude" });
		resetConfigModeForTest("independent");
		expect(autoModeSettingsPaths(home)).toEqual([ocUser]);
		expect(hookSettingsPaths(join(home, ".claude"), cwd, home).map((s) => [s.scope, s.path.startsWith(join(home, ".onecode"))])).toEqual([
			["user", true],
			["user", true],
		]);
		expect(configPaths(cwd, home)).toEqual([]);
		expect(readSettingsEnv(home)).toEqual({ A: "onecode" });
	});
});

describe("the /memory picker in independent mode", () => {
	it("offers the global ONECODE.md and the project's AGENTS.md, never a CLAUDE.md", () => {
		resetConfigModeForTest("independent");
		touch(join(cwd, "CLAUDE.md"));
		const entries = buildMemoryEntries({ cwd, home, homeClaudeDir: join(home, ".claude"), homeOneCodeDir: join(home, ".onecode"), memoryDir: join(home, "mem") });
		expect(entries.map((e) => [e.title, e.path])).toEqual([
			["User instructions", join(home, ".onecode", "ONECODE.md")],
			["Project instructions", join(cwd, "AGENTS.md")],
			["Open auto-memory folder", join(home, "mem")],
		]);
	});
});

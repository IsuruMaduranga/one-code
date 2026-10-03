import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLoopFile } from "../../extensions/background/loop-fire.ts";
import { claudeResourcePaths } from "../../extensions/claude-compat/index.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { defaultDiscoverRoots, discoverPlugins, invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { promptTemplateFiles, scanSkills } from "../../extensions/lib/skill-scan.ts";
import { agentDirs } from "../../extensions/subagents/agents.ts";
import { workflowDirs } from "../../extensions/workflow/saved-workflows.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "config-sources-"));
}
function touch(path: string, text = "x"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

describe("independent mode reads no Claude Code folder for skills, commands, agents and workflows", () => {
	it("claude-compat feeds pi only the cross-tool skills and the .onecode commands", () => {
		const home = scratch();
		const cwd = scratch();
		for (const dir of [join(home, ".claude", "skills"), join(cwd, ".claude", "skills"), join(home, ".agents", "skills"), join(cwd, ".agents", "skills")]) mkdirSync(dir, { recursive: true });
		for (const dir of [join(home, ".claude", "commands"), join(cwd, ".onecode", "commands"), join(home, ".onecode", "commands")]) mkdirSync(dir, { recursive: true });
		const env = { ONECODE_STATE_DIR: join(home, ".onecode") };
		Object.assign(process.env, env);
		try {
			const independent = claudeResourcePaths(cwd, home, join(home, ".claude"), undefined, "independent");
			expect(independent.skillPaths).toEqual([join(home, ".agents", "skills"), join(cwd, ".agents", "skills")]);
			expect(independent.promptPaths).toEqual([join(home, ".onecode", "commands"), join(cwd, ".onecode", "commands")]);
			const compatible = claudeResourcePaths(cwd, home, join(home, ".claude"), undefined, "claude-compatible");
			expect(compatible.skillPaths).toContain(join(home, ".claude", "skills"));
			expect(compatible.promptPaths).toEqual([join(home, ".claude", "commands")]);
		} finally {
			delete process.env.ONECODE_STATE_DIR;
		}
	});

	it("moves agents, workflows, prompt templates and loop.md to .onecode", () => {
		resetConfigModeForTest("independent");
		const home = scratch();
		const cwd = scratch();
		process.env.ONECODE_STATE_DIR = join(home, ".onecode");
		try {
			expect(agentDirs(cwd, home)).toEqual([join(home, ".onecode", "agents"), join(cwd, ".onecode", "agents")]);
			expect(workflowDirs(cwd, home)).toEqual({ project: join(cwd, ".onecode", "workflows"), user: join(home, ".onecode", "workflows") });
			touch(join(cwd, ".claude", "commands", "cc.md"));
			touch(join(cwd, ".onecode", "commands", "oc.md"));
			expect(promptTemplateFiles(cwd, home, join(home, "agent")).map((f) => f.name)).toEqual(["oc"]);
			touch(join(cwd, ".claude", "loop.md"), "claude tasks");
			expect(readLoopFile(cwd, home)).toBeNull();
			touch(join(cwd, ".onecode", "loop.md"), "own tasks");
			expect(readLoopFile(cwd, home)?.content).toBe("own tasks");
		} finally {
			delete process.env.ONECODE_STATE_DIR;
		}
	});

	it("scans no .claude skills", () => {
		resetConfigModeForTest("independent");
		const home = scratch();
		const cwd = scratch();
		touch(join(home, ".claude", "skills", "cc", "SKILL.md"));
		touch(join(cwd, ".agents", "skills", "shared", "SKILL.md"));
		expect(scanSkills(cwd, home, join(home, "agent"), []).map((s) => s.name)).toEqual(["shared"]);
	});

	it("skips Claude Code's installed plugins", () => {
		resetConfigModeForTest("independent");
		invalidatePluginsCache();
		const home = scratch();
		expect(defaultDiscoverRoots(join(home, "agent"), scratch(), home).readClaudePlugins).toBe(false);
		resetConfigModeForTest("claude-compatible");
		expect(defaultDiscoverRoots(join(home, "agent"), scratch(), home).readClaudePlugins).toBe(true);
		expect(discoverPlugins({ ...defaultDiscoverRoots(join(home, "agent"), scratch(), home), readClaudePlugins: false }).plugins).toEqual([]);
	});
});

describe("independent mode reads settings from One Code's files only", () => {
	it("permissions: rules and defaultMode from One Code's user file, nothing from .claude or managed", async () => {
		const { loadPermissionSettings } = await import("../../extensions/permissions/settings.ts");
		const home = scratch();
		const cwd = scratch();
		touch(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(cc:*)"], defaultMode: "plan" } }));
		touch(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(x)"] } }));
		touch(join(home, ".onecode", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(oc:*)"], defaultMode: "acceptEdits" } }));
		process.env.ONECODE_STATE_DIR = join(home, ".onecode");
		try {
			const independent = loadPermissionSettings(cwd, home, "independent");
			expect(independent.allow).toEqual(["Bash(oc:*)"]);
			expect(independent.deny).toEqual([]);
			expect(independent.defaultMode).toBe("acceptEdits");
			const compatible = loadPermissionSettings(cwd, home, "claude-compatible");
			expect(compatible.allow).toEqual(["Bash(cc:*)", "Bash(oc:*)"]);
			expect(compatible.deny).toEqual(["Read(x)"]);
			expect(compatible.defaultMode).toBe("plan");
		} finally {
			delete process.env.ONECODE_STATE_DIR;
		}
	});

	it("auto mode, hooks, MCP files, the env block and plugin state", async () => {
		const { autoModeSettingsPaths } = await import("../../extensions/auto-mode/config.ts");
		const { hookSettingsPaths } = await import("../../extensions/hooks/settings.ts");
		const { configPaths } = await import("../../extensions/mcp/config.ts");
		const { readSettingsEnv, readEnabledPlugins } = await import("../../extensions/lib/claude-settings.ts");
		const home = scratch();
		const cwd = scratch();
		process.env.ONECODE_STATE_DIR = join(home, ".onecode");
		try {
			const ocUser = join(home, ".onecode", "settings.json");
			expect(autoModeSettingsPaths(home, "independent")).toEqual([ocUser]);
			expect(hookSettingsPaths(join(home, ".claude"), cwd, home, "independent").map((s) => [s.scope, s.path.startsWith(join(home, ".onecode"))])).toEqual([
				["user", true],
				["user", true],
			]);
			touch(join(cwd, ".mcp.json"), "{}");
			expect(configPaths(cwd, home, "independent")).toEqual([]);
			expect(configPaths(cwd, home, "claude-compatible")).toContain(join(cwd, ".mcp.json"));
			touch(join(home, ".claude", "settings.json"), JSON.stringify({ env: { A: "claude" }, enabledPlugins: { "p@m": false } }));
			touch(ocUser, JSON.stringify({ env: { A: "onecode" } }));
			expect(readSettingsEnv(home, "independent")).toEqual({ A: "onecode" });
			expect(readSettingsEnv(home, "claude-compatible")).toEqual({ A: "claude" });
			expect(readEnabledPlugins(cwd, home, "independent")).toEqual({});
		} finally {
			delete process.env.ONECODE_STATE_DIR;
		}
	});
});

describe("the /memory picker in independent mode", () => {
	it("offers the global ONECODE.md and the project's AGENTS.md, never a CLAUDE.md", async () => {
		const { buildMemoryEntries } = await import("../../extensions/memory/entries.ts");
		resetConfigModeForTest("independent");
		const home = scratch();
		const cwd = scratch();
		touch(join(cwd, "CLAUDE.md"));
		const entries = buildMemoryEntries({ cwd, home, homeClaudeDir: join(home, ".claude"), homeOneCodeDir: join(home, ".onecode"), memoryDir: join(home, "mem") });
		expect(entries.map((e) => [e.title, e.path])).toEqual([
			["User instructions", join(home, ".onecode", "ONECODE.md")],
			["Project instructions", join(cwd, "AGENTS.md")],
			["Open auto-memory folder", join(home, "mem")],
		]);
	});
});

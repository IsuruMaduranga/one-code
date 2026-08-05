import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findPluginCommands,
	findPluginSkills,
	loadInstalledPlugins,
	type Plugin,
	pluginResources,
	splitPluginKey,
} from "../../extensions/lib/plugins.ts";
import {
	findShellPlaceholders,
	replaceShellPlaceholders,
	substituteArguments,
} from "../../extensions/plugins/template.ts";

describe("splitPluginKey", () => {
	it("splits name@marketplace", () => {
		expect(splitPluginKey("pr-review-toolkit@claude-plugins-official")).toEqual({
			name: "pr-review-toolkit",
			marketplace: "claude-plugins-official",
		});
	});

	it("handles a bare name", () => {
		expect(splitPluginKey("local-plugin")).toEqual({ name: "local-plugin" });
	});
});

describe("plugin discovery", () => {
	let root: string;
	let claudeDir: string;
	let installPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cc-plugins-"));
		claudeDir = join(root, ".claude");
		installPath = join(claudeDir, "plugins", "cache", "market", "demo", "1.0.0");
		mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(installPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "demo", description: "A demo plugin" }),
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const writeRegistry = (plugins: Record<string, unknown[]>) => {
		mkdirSync(join(claudeDir, "plugins"), { recursive: true });
		writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
	};

	it("reads the registry and the plugin manifest", () => {
		writeRegistry({ "demo@market": [{ scope: "user", installPath, version: "1.0.0" }] });
		const plugins = loadInstalledPlugins(claudeDir);
		expect(plugins).toHaveLength(1);
		expect(plugins[0]).toMatchObject({ name: "demo", marketplace: "market", version: "1.0.0", description: "A demo plugin" });
	});

	it("skips entries whose install path is gone, and disabled ones", () => {
		writeRegistry({
			"demo@market": [{ scope: "user", installPath, version: "1.0.0" }],
			"ghost@market": [{ scope: "user", installPath: join(root, "missing") }],
			"off@market": [{ scope: "user", installPath, enabled: false }],
		});
		expect(loadInstalledPlugins(claudeDir).map((p) => p.name)).toEqual(["demo"]);
	});

	it("returns nothing when the registry is absent or malformed", () => {
		expect(loadInstalledPlugins(claudeDir)).toEqual([]);
		mkdirSync(join(claudeDir, "plugins"), { recursive: true });
		writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "{ broken");
		expect(loadInstalledPlugins(claudeDir)).toEqual([]);
	});

	it("detects only the resource directories that exist", () => {
		const plugin: Plugin = { name: "demo", path: installPath };
		expect(pluginResources(plugin)).toEqual({
			agentsDir: undefined,
			commandsDir: undefined,
			skillsDir: undefined,
			mcpConfig: undefined,
		});

		mkdirSync(join(installPath, "agents"), { recursive: true });
		mkdirSync(join(installPath, "skills"), { recursive: true });
		writeFileSync(join(installPath, ".mcp.json"), "{}");
		const resources = pluginResources(plugin);
		expect(resources.agentsDir).toBe(join(installPath, "agents"));
		expect(resources.skillsDir).toBe(join(installPath, "skills"));
		expect(resources.mcpConfig).toBe(join(installPath, ".mcp.json"));
		expect(resources.commandsDir).toBeUndefined();
	});

	it("namespaces skills and commands by plugin name", () => {
		const plugin: Plugin = { name: "demo", path: installPath };
		mkdirSync(join(installPath, "skills", "improver"), { recursive: true });
		writeFileSync(join(installPath, "skills", "improver", "SKILL.md"), "---\nname: improver\n---\nbody");
		mkdirSync(join(installPath, "skills", "not-a-skill"), { recursive: true });
		mkdirSync(join(installPath, "commands"), { recursive: true });
		writeFileSync(join(installPath, "commands", "commit.md"), "body");
		writeFileSync(join(installPath, "commands", "notes.txt"), "ignored");

		expect(findPluginSkills(plugin, join(installPath, "skills"))).toEqual([
			{ name: "demo:improver", plugin: "demo", path: join(installPath, "skills", "improver", "SKILL.md") },
		]);
		expect(findPluginCommands(plugin, join(installPath, "commands"))).toEqual([
			{ name: "demo:commit", plugin: "demo", path: join(installPath, "commands", "commit.md") },
		]);
	});
});

describe("command template expansion", () => {
	it("substitutes $ARGUMENTS, $@ and positional arguments", () => {
		expect(substituteArguments("run $1 then $2", "alpha beta")).toBe("run alpha then beta");
		expect(substituteArguments("all: $ARGUMENTS", "  a b  ")).toBe("all: a b");
		expect(substituteArguments("all: $@", "a b")).toBe("all: a b");
	});

	it("leaves missing positionals empty", () => {
		expect(substituteArguments("[$1][$2]", "only")).toBe("[only][]");
	});

	it("finds and replaces shell placeholders", () => {
		const body = "status:\n!`git status`\ndiff:\n!`git diff`\nagain:\n!`git status`";
		expect(findShellPlaceholders(body)).toEqual(["git status", "git diff", "git status"]);
		const replaced = replaceShellPlaceholders(
			body,
			new Map([
				["git status", "clean"],
				["git diff", "no changes"],
			]),
		);
		expect(replaced).toContain("status:\nclean");
		expect(replaced).toContain("diff:\nno changes");
		expect(replaced).not.toContain("!`");
	});

	it("handles a body with no placeholders", () => {
		expect(findShellPlaceholders("plain body")).toEqual([]);
	});
});

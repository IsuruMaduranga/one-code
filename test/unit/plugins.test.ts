import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DiscoverRoots,
	discoverPlugins,
	findPluginCommands,
	findPluginSkills,
	invalidatePluginsCache,
	loadInstalledPlugins,
	pluginResources,
	splitPluginKey,
} from "../../extensions/lib/plugins.ts";
import { setOverride } from "../../extensions/lib/plugin-overrides.ts";
import { setSkillOverride, skillOverrideKey } from "../../extensions/lib/skill-overrides.ts";
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
		const plugins = loadInstalledPlugins(join(claudeDir, "plugins"));
		expect(plugins).toHaveLength(1);
		expect(plugins[0]).toMatchObject({
			id: "demo@market",
			name: "demo",
			marketplace: "market",
			version: "1.0.0",
			description: "A demo plugin",
		});
	});

	it("skips entries whose install path is gone; enabled passes through raw", () => {
		writeRegistry({
			"demo@market": [{ scope: "user", installPath, version: "1.0.0" }],
			"ghost@market": [{ scope: "user", installPath: join(root, "missing") }],
			"off@market": [{ scope: "user", installPath, enabled: false }],
		});
		const plugins = loadInstalledPlugins(join(claudeDir, "plugins"));
		// No enabled policy at this layer — Claude Code's own entries carry no
		// enabled field, so the loader only drops missing install paths.
		expect(plugins.map((p) => p.id).sort()).toEqual(["demo@market", "off@market"]);
		expect(plugins.find((p) => p.id === "off@market")?.rawEnabled).toBe(false);
		expect(plugins.find((p) => p.id === "demo@market")?.rawEnabled).toBeUndefined();
	});

	it("returns nothing when the registry is absent or malformed", () => {
		expect(loadInstalledPlugins(join(claudeDir, "plugins"))).toEqual([]);
		mkdirSync(join(claudeDir, "plugins"), { recursive: true });
		writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "{ broken");
		expect(loadInstalledPlugins(join(claudeDir, "plugins"))).toEqual([]);
	});

	it("detects only the resource directories that exist", () => {
		const plugin = { name: "demo", path: installPath };
		expect(pluginResources(plugin)).toEqual({
			agentsDir: undefined,
			commandsDir: undefined,
			skillsDir: undefined,
			mcpConfig: undefined,
			hooksConfig: undefined,
			lspConfig: undefined,
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
		const plugin = { name: "demo", path: installPath };
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

describe("discoverPlugins two-root merge", () => {
	let root: string;
	let roots: DiscoverRoots;

	const writePlugin = (base: string, name: string, extra?: { skill?: string }) => {
		const installPath = join(base, "cache", "market", name, "1.0.0");
		mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
		writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
		if (extra?.skill) {
			mkdirSync(join(installPath, "skills", extra.skill), { recursive: true });
			writeFileSync(join(installPath, "skills", extra.skill, "SKILL.md"), "---\nname: s\n---\nbody");
		}
		return installPath;
	};

	const writeRegistry = (base: string, plugins: Record<string, unknown[]>) => {
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cc-plugins-merge-"));
		roots = {
			claudePluginsDir: join(root, ".claude", "plugins"),
			oneCodeRoot: join(root, "one-code", "plugins"),
			cwd: join(root, "project"),
			home: root,
		};
		mkdirSync(roots.cwd, { recursive: true });
		invalidatePluginsCache();
	});
	afterEach(() => {
		invalidatePluginsCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("claude-origin: enabledPlugins from settings, default true when absent", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha");
		const b = writePlugin(roots.claudePluginsDir, "beta");
		writeRegistry(roots.claudePluginsDir, {
			"alpha@market": [{ scope: "user", installPath: a }],
			"beta@market": [{ scope: "user", installPath: b }],
		});
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "beta@market": false } }));

		const discovered = discoverPlugins(roots);
		expect(discovered.plugins.find((p) => p.id === "alpha@market")).toMatchObject({
			originRoot: "claude",
			enabled: true,
			overridden: false,
		});
		expect(discovered.plugins.find((p) => p.id === "beta@market")?.enabled).toBe(false);
		expect(discovered.enabledPlugins.map((p) => p.id)).toEqual(["alpha@market"]);
	});

	it("project/local settings win over user settings per key", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha");
		writeRegistry(roots.claudePluginsDir, { "alpha@market": [{ scope: "user", installPath: a }] });
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@market": false } }));
		mkdirSync(join(roots.cwd, ".claude"), { recursive: true });
		writeFileSync(join(roots.cwd, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "alpha@market": true } }));

		expect(discoverPlugins(roots).plugins[0]?.enabled).toBe(true);
	});

	it("overrides.json wins over Claude Code settings and marks the plugin overridden", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha");
		writeRegistry(roots.claudePluginsDir, { "alpha@market": [{ scope: "user", installPath: a }] });
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@market": true } }));
		setOverride(roots.oneCodeRoot, "alpha@market", false);
		invalidatePluginsCache();

		expect(discoverPlugins(roots).plugins[0]).toMatchObject({ enabled: false, overridden: true });
	});

	it("one-code origin: entry-level enabled respected, dataRoot points at our root", () => {
		const a = writePlugin(roots.oneCodeRoot, "ours");
		writeRegistry(roots.oneCodeRoot, { "ours@market": [{ scope: "user", installPath: a, enabled: false }] });

		const plugin = discoverPlugins(roots).plugins[0];
		expect(plugin).toMatchObject({ originRoot: "one-code", enabled: false, rawEnabled: false });
		expect(plugin?.dataRoot).toBe(join(roots.oneCodeRoot, "data"));
	});

	it("same id in both roots: the one-code copy wins", () => {
		const claude = writePlugin(roots.claudePluginsDir, "dup");
		const ours = writePlugin(roots.oneCodeRoot, "dup");
		writeRegistry(roots.claudePluginsDir, { "dup@market": [{ scope: "user", installPath: claude }] });
		writeRegistry(roots.oneCodeRoot, { "dup@market": [{ scope: "user", installPath: ours }] });

		const discovered = discoverPlugins(roots);
		expect(discovered.plugins).toHaveLength(1);
		expect(discovered.plugins[0]).toMatchObject({ originRoot: "one-code", path: ours });
	});

	it("disabled plugins contribute no resources but still appear in plugins/byPlugin", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha", { skill: "helper" });
		writeRegistry(roots.claudePluginsDir, { "alpha@market": [{ scope: "user", installPath: a }] });
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@market": false } }));

		const discovered = discoverPlugins(roots);
		expect(discovered.plugins).toHaveLength(1);
		expect(discovered.skills).toEqual([]);
		expect(discovered.byPlugin.get("alpha@market")?.skills).toBe(1);
	});

	it("skill overrides drop individual plugin skills from the wired set", () => {
		const a = writePlugin(roots.oneCodeRoot, "ours", { skill: "helper" });
		writeRegistry(roots.oneCodeRoot, { "ours@market": [{ scope: "user", installPath: a }] });
		setSkillOverride(roots.oneCodeRoot, skillOverrideKey("plugin", "ours:helper"), false);
		invalidatePluginsCache();

		expect(discoverPlugins(roots).skills).toEqual([]);
	});

	it("caches per roots; invalidatePluginsCache forces a re-read", () => {
		const a = writePlugin(roots.oneCodeRoot, "ours");
		writeRegistry(roots.oneCodeRoot, { "ours@market": [{ scope: "user", installPath: a, enabled: true }] });
		expect(discoverPlugins(roots).plugins[0]?.enabled).toBe(true);

		writeRegistry(roots.oneCodeRoot, { "ours@market": [{ scope: "user", installPath: a, enabled: false }] });
		expect(discoverPlugins(roots).plugins[0]?.enabled).toBe(true); // cached
		invalidatePluginsCache();
		expect(discoverPlugins(roots).plugins[0]?.enabled).toBe(false);
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

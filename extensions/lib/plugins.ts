/**
 * Claude Code plugin discovery (pure).
 *
 * Two roots are merged:
 *
 *   ~/.claude/plugins/            Claude Code's own installs — READ-ONLY.
 *   <agentDir>/plugins/           One Code's installs (lib/plugin-root.ts) —
 *                                 the only root One Code ever writes.
 *
 * Both hold the same on-disk format:
 *
 *   <root>/installed_plugins.json
 *     { "version": 2, "plugins": { "<name>@<marketplace>": [{ scope, installPath, version, ... }] } }
 *
 *   <installPath>/.claude-plugin/plugin.json   { name, description, author }
 *   <installPath>/agents/*.md                  agent definitions
 *   <installPath>/commands/*.md                slash commands
 *   <installPath>/skills/<name>/SKILL.md       skills
 *   <installPath>/.mcp.json                    MCP servers
 *   <installPath>/.lsp.json                    LSP servers (extensions/lsp)
 *
 * Enabled state differs by origin: Claude Code keeps it in settings.json's
 * `enabledPlugins` map (its installed_plugins.json entries have NO enabled
 * field), overridable from One Code via <one-code root>/overrides.json;
 * One Code's own entries carry `enabled` directly (we own that schema copy).
 *
 * Claude Code namespaces everything a plugin provides as `<plugin>:<name>`, so
 * two plugins can both ship a `commit` command.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { readJsonFile } from "./atomic-write.ts";
import { readEnabledPlugins } from "./claude-settings.ts";
import { readOverrides } from "./plugin-overrides.ts";
import { pluginRoot } from "./plugin-root.ts";
import { isSkillEnabled, readSkillStates, skillOverrideKey } from "./skill-overrides.ts";

export interface PluginManifest {
	name?: string;
	description?: string;
}

export type PluginOrigin = "claude" | "one-code";

export interface Plugin {
	/** Raw registry key (`<name>@<marketplace>`) — what enabledPlugins/overrides key on. */
	id: string;
	/** Plugin name, without the @marketplace suffix (manifest name when present). */
	name: string;
	marketplace?: string;
	path: string;
	version?: string;
	description?: string;
	/** Which root the plugin was discovered under. */
	originRoot: PluginOrigin;
	/** Effective enabled state after settings/override merging. */
	enabled: boolean;
	/** True when a claude-origin plugin's state comes from our overrides.json. */
	overridden?: boolean;
	/** Base dir for the plugin's `${CLAUDE_PLUGIN_DATA}` (per-origin). */
	dataRoot: string;
	/** Raw `enabled` from the installed_plugins.json entry (meaningful only for one-code origin). */
	rawEnabled?: boolean;
}

export interface PluginResources {
	agentsDir?: string;
	commandsDir?: string;
	skillsDir?: string;
	mcpConfig?: string;
	/** <plugin>/hooks/hooks.json when present — consumed by extensions/hooks. */
	hooksConfig?: string;
	/** <plugin>/.lsp.json when present — consumed by extensions/lsp. */
	lspConfig?: string;
}

interface InstalledEntry {
	scope?: string;
	installPath?: string;
	version?: string;
	enabled?: boolean;
}

export function splitPluginKey(key: string): { name: string; marketplace?: string } {
	const at = key.lastIndexOf("@");
	if (at <= 0) return { name: key };
	return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** Read a file's raw contents, or `undefined` if it doesn't exist or can't be read. */
export function tryReadFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/** One root's installed plugins, before enabled-policy is applied. */
export interface InstalledPlugin {
	id: string;
	name: string;
	marketplace?: string;
	path: string;
	version?: string;
	description?: string;
	rawEnabled?: boolean;
}

/**
 * Reads a root's installed-plugin registry (`<pluginsDir>/installed_plugins.json`).
 * Format reader only — no enabled policy here: Claude Code's entries carry no
 * enabled field (that state lives in settings.json), so the first entry with an
 * existing installPath wins; a raw `enabled` value is passed through for the
 * One Code root, where the entry schema is ours.
 */
export function loadInstalledPlugins(pluginsDir: string): InstalledPlugin[] {
	const registry = readJsonFile<{ plugins?: Record<string, InstalledEntry[]> }>(
		join(pluginsDir, "installed_plugins.json"),
	);
	if (!registry?.plugins) return [];

	const plugins: InstalledPlugin[] = [];
	for (const [key, entries] of Object.entries(registry.plugins)) {
		if (!Array.isArray(entries) || entries.length === 0) continue;
		const entry = entries.find((e) => e.installPath && existsSync(e.installPath));
		if (!entry?.installPath) continue;

		const { name, marketplace } = splitPluginKey(key);
		const manifest = readJsonFile<PluginManifest>(join(entry.installPath, ".claude-plugin", "plugin.json"));
		plugins.push({
			id: key,
			name: manifest?.name || name,
			marketplace,
			path: entry.installPath,
			version: entry.version,
			description: manifest?.description,
			rawEnabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
		});
	}
	return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export function pluginResources(plugin: Pick<Plugin, "path">): PluginResources {
	const dirIfExists = (name: string) => {
		const path = join(plugin.path, name);
		return existsSync(path) && statSync(path).isDirectory() ? path : undefined;
	};
	const fileIfExists = (...segments: string[]) => {
		const path = join(plugin.path, ...segments);
		return existsSync(path) ? path : undefined;
	};
	return {
		agentsDir: dirIfExists("agents"),
		commandsDir: dirIfExists("commands"),
		skillsDir: dirIfExists("skills"),
		mcpConfig: fileIfExists(".mcp.json"),
		hooksConfig: fileIfExists("hooks", "hooks.json"),
		lspConfig: fileIfExists(".lsp.json"),
	};
}

export interface PluginSkill {
	/** Namespaced `<plugin>:<skill>`, as Claude Code presents it. */
	name: string;
	plugin: string;
	path: string;
}

/** Each immediate subdirectory holding a SKILL.md is one skill. */
export function findPluginSkills(plugin: Pick<Plugin, "name">, skillsDir: string): PluginSkill[] {
	const skills: PluginSkill[] = [];
	let entries: string[];
	try {
		entries = readdirSync(skillsDir);
	} catch {
		return skills;
	}
	for (const entry of entries) {
		const skillFile = join(skillsDir, entry, "SKILL.md");
		if (existsSync(skillFile)) {
			skills.push({ name: `${plugin.name}:${entry}`, plugin: plugin.name, path: skillFile });
		}
	}
	return skills;
}

export interface PluginCommand {
	/** Namespaced `<plugin>:<command>`. */
	name: string;
	plugin: string;
	path: string;
}

export function findPluginCommands(plugin: Pick<Plugin, "name">, commandsDir: string): PluginCommand[] {
	let entries: string[];
	try {
		entries = readdirSync(commandsDir);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => ({
			name: `${plugin.name}:${basename(entry, ".md")}`,
			plugin: plugin.name,
			path: join(commandsDir, entry),
		}));
}

/** The two roots + settings locations discovery reads from. */
export interface DiscoverRoots {
	/** Claude Code's plugins dir (`~/.claude/plugins`) — read-only. */
	claudePluginsDir: string;
	/** One Code's plugin root (`<agentDir>/plugins`) — ours to write. */
	oneCodeRoot: string;
	cwd: string;
	home: string;
}

/** The standard roots; wiring passes `getAgentDir()` (pure modules can't). */
export function defaultDiscoverRoots(agentDir: string, cwd: string = process.cwd(), home: string = os.homedir()): DiscoverRoots {
	return {
		claudePluginsDir: join(home, ".claude", "plugins"),
		oneCodeRoot: pluginRoot(agentDir),
		cwd,
		home,
	};
}

/**
 * The enabled-state precedence for a Claude Code-installed plugin: a One Code
 * override wins, then Claude Code's own settings, then default-enabled.
 */
export function claudePluginEnabled(
	id: string,
	ccEnabled: Record<string, boolean>,
	overrides: Record<string, boolean>,
): boolean {
	return overrides[id] ?? ccEnabled[id] ?? true;
}

/** One Code-installed plugins carry enabled on their own registry entry. */
export function oneCodePluginEnabled(rawEnabled: boolean | undefined): boolean {
	return rawEnabled ?? true;
}

/**
 * Everything the installed plugins contribute, resolved in one pass.
 *
 * IMPORTANT: this is a function each consuming extension calls for itself, not a
 * shared singleton. Under jiti every extension file gets its own module
 * instance, so module-level state written by one extension is invisible to
 * another — a shared registry silently read as empty. Re-deriving is cheap (a
 * few small JSON files plus directory checks) and has no load-order constraints.
 */
export interface NamespacedDir {
	dir: string;
	namespace: string;
}

export interface DiscoveredPlugins {
	/** Every installed plugin, enabled or not (the /plugins panel needs both). */
	plugins: Plugin[];
	/** Enabled plugins only — the set whose resources are wired in below. */
	enabledPlugins: Plugin[];
	agentDirs: NamespacedDir[];
	skills: PluginSkill[];
	commands: PluginCommand[];
	mcpConfigs: string[];
	/** Per-plugin summary keyed by plugin id, for status output. */
	byPlugin: Map<string, { agents: boolean; skills: number; commands: number; mcp: boolean; lsp: boolean }>;
}

let cache: { key: string; result: DiscoveredPlugins } | undefined;

/**
 * Drops this module instance's discovery cache. Only affects the calling
 * extension's own jiti module graph — other extensions' copies re-read on
 * their next session; the /plugins panel calls this after installs/toggles so
 * its own next discoverPlugins() reflects them immediately.
 */
export function invalidatePluginsCache(): void {
	cache = undefined;
}

export function discoverPlugins(roots: DiscoverRoots): DiscoveredPlugins {
	const key = [roots.claudePluginsDir, roots.oneCodeRoot, roots.cwd, roots.home].join("\n");
	if (cache?.key === key) return cache.result;

	const ccEnabled = readEnabledPlugins(roots.cwd, roots.home);
	const overrides = readOverrides(roots.oneCodeRoot);
	const skillOverrides = readSkillStates(roots.oneCodeRoot);

	const claudePlugins: Plugin[] = loadInstalledPlugins(roots.claudePluginsDir).map((p) => ({
		...p,
		originRoot: "claude" as const,
		enabled: claudePluginEnabled(p.id, ccEnabled, overrides),
		overridden: p.id in overrides,
		dataRoot: join(roots.claudePluginsDir, "data"),
	}));

	const oneCodePlugins: Plugin[] = loadInstalledPlugins(roots.oneCodeRoot).map((p) => ({
		...p,
		originRoot: "one-code" as const,
		enabled: oneCodePluginEnabled(p.rawEnabled),
		dataRoot: join(roots.oneCodeRoot, "data"),
	}));

	// Same plugin id installed under both roots: the One Code copy wins — it's
	// the one this harness actively manages.
	const byId = new Map<string, Plugin>();
	for (const plugin of [...claudePlugins, ...oneCodePlugins]) byId.set(plugin.id, plugin);
	const plugins = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
	const enabledPlugins = plugins.filter((p) => p.enabled);

	const result: DiscoveredPlugins = {
		plugins,
		enabledPlugins,
		agentDirs: [],
		skills: [],
		commands: [],
		mcpConfigs: [],
		byPlugin: new Map(),
	};

	for (const plugin of plugins) {
		const resources = pluginResources(plugin);
		const skills = resources.skillsDir ? findPluginSkills(plugin, resources.skillsDir) : [];
		const commands = resources.commandsDir ? findPluginCommands(plugin, resources.commandsDir) : [];

		result.byPlugin.set(plugin.id, {
			agents: !!resources.agentsDir,
			skills: skills.length,
			commands: commands.length,
			mcp: !!resources.mcpConfig,
			lsp: !!resources.lspConfig,
		});

		if (!plugin.enabled) continue;
		if (resources.agentsDir) result.agentDirs.push({ dir: resources.agentsDir, namespace: plugin.name });
		result.skills.push(...skills.filter((s) => isSkillEnabled(skillOverrides, skillOverrideKey("plugin", s.name))));
		result.commands.push(...commands);
		if (resources.mcpConfig) result.mcpConfigs.push(resources.mcpConfig);
	}

	cache = { key, result };
	return result;
}

/**
 * Claude Code plugin discovery (pure).
 *
 * On-disk reality, read from a real installation:
 *
 *   ~/.claude/plugins/installed_plugins.json
 *     { "version": 2, "plugins": { "<name>@<marketplace>": [{ scope, installPath, version }] } }
 *
 *   <installPath>/.claude-plugin/plugin.json   { name, description, author }
 *   <installPath>/agents/*.md                  agent definitions
 *   <installPath>/commands/*.md                slash commands
 *   <installPath>/skills/<name>/SKILL.md       skills
 *   <installPath>/.mcp.json                    MCP servers
 *
 * Claude Code namespaces everything a plugin provides as `<plugin>:<name>`, so
 * two plugins can both ship a `commit` command.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface PluginManifest {
	name?: string;
	description?: string;
}

export interface Plugin {
	/** Plugin name, without the @marketplace suffix. */
	name: string;
	marketplace?: string;
	path: string;
	version?: string;
	description?: string;
}

export interface PluginResources {
	agentsDir?: string;
	commandsDir?: string;
	skillsDir?: string;
	mcpConfig?: string;
	/** <plugin>/hooks/hooks.json when present — consumed by extensions/hooks. */
	hooksConfig?: string;
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

function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	const raw = tryReadFile(path);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/** Reads the installed-plugin registry; the newest entry per plugin wins. */
export function loadInstalledPlugins(claudeDir: string): Plugin[] {
	const registry = readJsonFile<{ plugins?: Record<string, InstalledEntry[]> }>(
		join(claudeDir, "plugins", "installed_plugins.json"),
	);
	if (!registry?.plugins) return [];

	const plugins: Plugin[] = [];
	for (const [key, entries] of Object.entries(registry.plugins)) {
		if (!Array.isArray(entries) || entries.length === 0) continue;
		const entry = entries.find((e) => e.enabled !== false && e.installPath);
		if (!entry?.installPath || !existsSync(entry.installPath)) continue;

		const { name, marketplace } = splitPluginKey(key);
		const manifest = readJsonFile<PluginManifest>(join(entry.installPath, ".claude-plugin", "plugin.json"));
		plugins.push({
			name: manifest?.name || name,
			marketplace,
			path: entry.installPath,
			version: entry.version,
			description: manifest?.description,
		});
	}
	return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export function pluginResources(plugin: Plugin): PluginResources {
	const dirIfExists = (name: string) => {
		const path = join(plugin.path, name);
		return existsSync(path) && statSync(path).isDirectory() ? path : undefined;
	};
	const mcpConfig = join(plugin.path, ".mcp.json");
	const hooksConfig = join(plugin.path, "hooks", "hooks.json");
	return {
		agentsDir: dirIfExists("agents"),
		commandsDir: dirIfExists("commands"),
		skillsDir: dirIfExists("skills"),
		mcpConfig: existsSync(mcpConfig) ? mcpConfig : undefined,
		hooksConfig: existsSync(hooksConfig) ? hooksConfig : undefined,
	};
}

export interface PluginSkill {
	/** Namespaced `<plugin>:<skill>`, as Claude Code presents it. */
	name: string;
	plugin: string;
	path: string;
}

/** Each immediate subdirectory holding a SKILL.md is one skill. */
export function findPluginSkills(plugin: Plugin, skillsDir: string): PluginSkill[] {
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

export function findPluginCommands(plugin: Plugin, commandsDir: string): PluginCommand[] {
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

/**
 * Everything a plugin contributes, resolved in one pass.
 *
 * IMPORTANT: this is a function each consuming extension calls for itself, not a
 * shared singleton. Under jiti every extension file gets its own module
 * instance, so module-level state written by one extension is invisible to
 * another — a shared registry silently read as empty. Re-deriving is cheap (one
 * small JSON plus a few directory checks) and has no load-order constraints.
 */
export interface NamespacedDir {
	dir: string;
	namespace: string;
}

export interface DiscoveredPlugins {
	plugins: Plugin[];
	agentDirs: NamespacedDir[];
	skills: PluginSkill[];
	commands: PluginCommand[];
	mcpConfigs: string[];
	/** Per-plugin summary, for status output. */
	byPlugin: Map<string, { agents: boolean; skills: number; commands: number; mcp: boolean }>;
}

let cache: { claudeDir: string; result: DiscoveredPlugins } | undefined;

export function discoverPlugins(claudeDir: string): DiscoveredPlugins {
	if (cache?.claudeDir === claudeDir) return cache.result;

	const plugins = loadInstalledPlugins(claudeDir);
	const result: DiscoveredPlugins = {
		plugins,
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

		if (resources.agentsDir) result.agentDirs.push({ dir: resources.agentsDir, namespace: plugin.name });
		result.skills.push(...skills);
		result.commands.push(...commands);
		if (resources.mcpConfig) result.mcpConfigs.push(resources.mcpConfig);

		result.byPlugin.set(plugin.name, {
			agents: !!resources.agentsDir,
			skills: skills.length,
			commands: commands.length,
			mcp: !!resources.mcpConfig,
		});
	}

	cache = { claudeDir, result };
	return result;
}

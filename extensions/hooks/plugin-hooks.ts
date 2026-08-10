/**
 * Plugin hook discovery (pure): each enabled plugin's hooks/hooks.json,
 * re-derived per call via lib/plugins.ts like every other plugin consumer
 * (no cross-extension state under jiti).
 *
 * Plugin hooks are user scope — installing the plugin was the consent step —
 * so they run without the project-trust prompt, matching how plugin commands,
 * skills, and MCP servers already work.
 */

import { readFileSync, statSync } from "node:fs";
import { discoverPlugins, pluginResources } from "../lib/plugins.ts";
import { parseHooksBlock, type HooksSource } from "./settings.ts";

interface CacheEntry {
	mtimeMs: number;
	source: HooksSource | undefined;
	diagnostics: string[];
}

/**
 * `loadPluginHooks` runs on every tool_call AND tool_result, so each plugin's
 * hooks.json is mtime-cached like the settings files (settings.ts) instead of
 * re-read and re-validated twice per tool invocation.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Read one plugin hooks.json. CC's format nests events under a "hooks" key;
 * a bare top-level events map is accepted too, defensively. Commands may
 * reference ${CLAUDE_PLUGIN_ROOT}, expanded to the plugin's install path.
 */
function readPluginHooksFile(hooksConfig: string, pluginName: string, pluginPath: string, diagnostics: string[]): HooksSource | undefined {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(hooksConfig).mtimeMs;
	} catch {
		cache.delete(hooksConfig);
		return undefined;
	}
	const cached = cache.get(hooksConfig);
	if (cached && cached.mtimeMs === mtimeMs) {
		diagnostics.push(...cached.diagnostics);
		return cached.source;
	}
	const fileDiagnostics: string[] = [];
	let source: HooksSource | undefined;
	try {
		const parsed = JSON.parse(readFileSync(hooksConfig, "utf-8")) as Record<string, unknown>;
		const block = typeof parsed.hooks === "object" && parsed.hooks !== null ? parsed.hooks : parsed;
		const config = parseHooksBlock(block, hooksConfig, fileDiagnostics);
		for (const entries of Object.values(config)) {
			for (const entry of entries) {
				for (const hook of entry.hooks) {
					hook.command = hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginPath);
				}
			}
		}
		if (Object.keys(config).length > 0) {
			source = { scope: "plugin", path: hooksConfig, pluginName, config };
		}
	} catch (error) {
		fileDiagnostics.push(`${hooksConfig}: unreadable plugin hooks skipped (${error instanceof Error ? error.message : error})`);
	}
	cache.set(hooksConfig, { mtimeMs, source, diagnostics: fileDiagnostics });
	diagnostics.push(...fileDiagnostics);
	return source;
}

export function loadPluginHooks(claudeDir: string, diagnostics: string[]): HooksSource[] {
	const sources: HooksSource[] = [];
	for (const plugin of discoverPlugins(claudeDir).plugins) {
		const { hooksConfig } = pluginResources(plugin);
		if (!hooksConfig) continue;
		const source = readPluginHooksFile(hooksConfig, plugin.name, plugin.path, diagnostics);
		if (source) sources.push(source);
	}
	return sources;
}

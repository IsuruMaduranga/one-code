/**
 * Plugin hook discovery (pure): each enabled plugin's hooks/hooks.json,
 * re-derived per call via lib/plugins.ts like every other plugin consumer
 * (no cross-extension state under jiti).
 *
 * Plugin hooks are user scope — installing the plugin was the consent step —
 * so they run without the project-trust prompt, matching how plugin commands,
 * skills, and MCP servers already work.
 */

import { readFileSync } from "node:fs";
import { discoverPlugins, pluginResources } from "../lib/plugins.ts";
import { parseHooksBlock, type HooksSource } from "./settings.ts";

/**
 * Read one plugin hooks.json. CC's format nests events under a "hooks" key;
 * a bare top-level events map is accepted too, defensively. Commands may
 * reference ${CLAUDE_PLUGIN_ROOT}, expanded to the plugin's install path.
 */
export function loadPluginHooks(claudeDir: string, diagnostics: string[]): HooksSource[] {
	const sources: HooksSource[] = [];
	for (const plugin of discoverPlugins(claudeDir).plugins) {
		const { hooksConfig } = pluginResources(plugin);
		if (!hooksConfig) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(readFileSync(hooksConfig, "utf-8")) as Record<string, unknown>;
		} catch (error) {
			diagnostics.push(`${hooksConfig}: unreadable plugin hooks skipped (${error instanceof Error ? error.message : error})`);
			continue;
		}
		const block = typeof parsed.hooks === "object" && parsed.hooks !== null ? parsed.hooks : parsed;
		const config = parseHooksBlock(block, hooksConfig, diagnostics);
		for (const entries of Object.values(config)) {
			for (const entry of entries) {
				for (const hook of entry.hooks) {
					hook.command = hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin.path);
				}
			}
		}
		if (Object.keys(config).length > 0) {
			sources.push({ scope: "plugin", path: hooksConfig, pluginName: plugin.name, config });
		}
	}
	return sources;
}

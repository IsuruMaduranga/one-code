/**
 * One Code-local enable/disable overrides for Claude Code-installed plugins
 * (pure fs, no pi imports).
 *
 * A plugin installed under ~/.claude keeps its enabled state in Claude Code's
 * own settings.json, which One Code never writes. Toggling such a plugin from
 * One Code therefore records an override here (`<plugin root>/overrides.json`,
 * `{"name@marketplace": boolean}`), applied on top of Claude Code's state
 * during discovery. Plugins installed by One Code itself store `enabled`
 * directly on their installed_plugins.json entry and never appear here.
 */

import { join } from "node:path";
import { readBooleanMap, setBooleanMapEntry } from "./atomic-write.ts";

const FILE = "overrides.json";

export function readOverrides(root: string): Record<string, boolean> {
	return readBooleanMap(join(root, FILE));
}

export function setOverride(root: string, pluginId: string, enabled: boolean): void {
	setBooleanMapEntry(join(root, FILE), pluginId, enabled);
}

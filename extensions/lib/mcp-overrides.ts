/**
 * Persisted "disabled MCP server" overrides (pure-ish — touches only ~/.onecode).
 *
 * The /mcp panel's Disable/Enable action persists across sessions here rather
 * than by mutating the user's `~/.claude.json` or a plugin's `.mcp.json`: those
 * are Claude Code's / a plugin's config, which One Code only ever reads (the
 * "own state, borrowed config" rule — docs/decisions/memory-state.md). A
 * disabled server is still discovered and listed; the mcp extension just skips
 * connecting it, and the panel offers Enable to bring it back.
 *
 * Scope mirrors the settings layout: a server configured in the user file
 * (`~/.claude.json`) disables at user scope so it stays disabled everywhere;
 * anything project/local/plugin disables per-repo so it doesn't leak across
 * projects. Reads merge both scopes.
 */

import os from "node:os";
import { oneCodeProjectSettingsPath, oneCodeSettingsPath, readSettingsForWrite, writeSettings } from "./one-code-settings.ts";

const KEY = "disabledMcpServers";

export type McpDisableScope = "user" | "project";

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function namesAt(path: string): string[] {
	return stringArray(readSettingsForWrite(path)[KEY]);
}

/** Server names disabled at either scope, merged. */
export function readDisabledMcpServers(
	cwd: string,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): Set<string> {
	return new Set([...namesAt(oneCodeSettingsPath(home, env)), ...namesAt(oneCodeProjectSettingsPath(cwd, home, env))]);
}

/** Add or remove a server from the disabled list at the given scope. */
export function setMcpServerDisabled(
	name: string,
	disabled: boolean,
	scope: McpDisableScope,
	cwd: string,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	const path = scope === "user" ? oneCodeSettingsPath(home, env) : oneCodeProjectSettingsPath(cwd, home, env);
	const file = readSettingsForWrite(path);
	const set = new Set(stringArray(file[KEY]));
	if (disabled) set.add(name);
	else set.delete(name);
	file[KEY] = [...set].sort();
	writeSettings(path, file);
}

/**
 * Read-only access to Claude Code's settings files (pure fs, no pi imports).
 *
 * Sources, lowest to highest precedence — the same ladder the permissions
 * extension merges:
 *   ~/.claude/settings.json           (user)
 *   <cwd>/.claude/settings.json       (project, checked in)
 *   <cwd>/.claude/settings.local.json (project, personal)
 *
 * One Code NEVER writes these files. Plugin enable/disable initiated from One
 * Code goes to the One Code plugin root (lib/plugin-overrides.ts), never here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeSettingsFile {
	enabledPlugins?: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * Claude Code's *user* settings file. The one canonical statement of that path,
 * so the loaders that must recognise "the borrowed `.claude` user file" (to skip
 * One Code's own keys found there) all compare against the same value.
 */
export function claudeUserSettingsPath(home: string): string {
	return join(home, ".claude", "settings.json");
}

export function settingsPaths(cwd: string, home: string): { user: string; project: string; local: string } {
	return {
		user: claudeUserSettingsPath(home),
		project: join(cwd, ".claude", "settings.json"),
		local: join(cwd, ".claude", "settings.local.json"),
	};
}

export function readSettingsFile(path: string): ClaudeSettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettingsFile;
	} catch {
		return undefined;
	}
}

/**
 * Claude Code's plugin enabled-state map (`{"name@marketplace": boolean}`),
 * merged across the three settings files — later files win per key.
 */
export function readEnabledPlugins(cwd: string, home: string): Record<string, boolean> {
	const paths = settingsPaths(cwd, home);
	const merged: Record<string, boolean> = {};
	for (const path of [paths.user, paths.project, paths.local]) {
		const enabled = readSettingsFile(path)?.enabledPlugins;
		if (!enabled || typeof enabled !== "object") continue;
		for (const [key, value] of Object.entries(enabled)) {
			if (typeof value === "boolean") merged[key] = value;
		}
	}
	return merged;
}

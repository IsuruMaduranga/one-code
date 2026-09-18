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
import { claudeUserDir } from "./paths.ts";

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
	return join(claudeUserDir(home), "settings.json");
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
 * Claude Code's `env` block from the USER settings file only: the string
 * values it would export into every session. Read for `CLAUDE_CODE_GIT_BASH_PATH`
 * (lib/shell-spawn.ts). Project and local files are deliberately not merged —
 * a checked-in `env` that pointed the shell at a `tools/bash` inside the repo
 * would run that binary for every hook and background command, and the file
 * is the repository's, not the user's (Claude Code gates the same block behind
 * its project-trust prompt).
 */
export function readSettingsEnv(home: string): Record<string, string> {
	const env = readSettingsFile(claudeUserSettingsPath(home))?.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
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

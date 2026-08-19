/**
 * Claude Code settings.json permissions loading/merging/persistence (pure fs).
 *
 * Sources, lowest to highest precedence:
 *   ~/.claude/settings.json          (user)
 *   <cwd>/.claude/settings.json      (project, checked in)
 *   <cwd>/.claude/settings.local.json (project, personal)
 *
 * allow/deny/ask arrays concatenate across sources; defaultMode from the most
 * specific source wins. Unknown keys in the files are preserved on write.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readSettingsFile as readClaudeSettingsFile, settingsPaths } from "../lib/claude-settings.ts";
import type { PermissionMode } from "./matcher.ts";

export { settingsPaths };

export interface PermissionSettings {
	allow: string[];
	deny: string[];
	ask: string[];
	defaultMode?: PermissionMode;
}

interface ClaudeSettingsFile {
	permissions?: {
		allow?: string[];
		deny?: string[];
		ask?: string[];
		defaultMode?: string;
	};
	[key: string]: unknown;
}

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

/** Display-name aliases Claude Code accepts wherever a mode is named. */
const MODE_ALIASES: Record<string, PermissionMode> = { manual: "default" };

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (MODES as string[]).includes(value);
}

/** A mode value from user input (flag, settings, env), aliases included. */
export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
	if (isPermissionMode(value)) return value;
	return typeof value === "string" ? MODE_ALIASES[value] : undefined;
}

function readSettingsFile(path: string): ClaudeSettingsFile | undefined {
	// Shared reader (lib/claude-settings.ts) — this module narrows to the
	// permissions-relevant shape.
	return readClaudeSettingsFile(path) as ClaudeSettingsFile | undefined;
}

export function loadPermissionSettings(cwd: string, home: string): PermissionSettings {
	const paths = settingsPaths(cwd, home);
	const merged: PermissionSettings = { allow: [], deny: [], ask: [] };

	for (const path of [paths.user, paths.project, paths.local]) {
		const file = readSettingsFile(path);
		const perms = file?.permissions;
		if (!perms) continue;
		if (Array.isArray(perms.allow)) merged.allow.push(...perms.allow.filter((r) => typeof r === "string"));
		if (Array.isArray(perms.deny)) merged.deny.push(...perms.deny.filter((r) => typeof r === "string"));
		if (Array.isArray(perms.ask)) merged.ask.push(...perms.ask.filter((r) => typeof r === "string"));
		const defaultMode = normalizePermissionMode(perms.defaultMode);
		// `auto` is honoured from user settings only. Both project files live in the
		// repository, so accepting it there would let a checked-in file put the
		// session into auto mode — a repo granting itself the looser mode whose
		// classifier is what contains it. Claude Code makes the same exclusion.
		if (defaultMode && !(defaultMode === "auto" && path !== paths.user)) {
			merged.defaultMode = defaultMode;
		}
	}

	return merged;
}

/** Append an allow rule to a settings file, creating it if needed. */
export function persistAllowRule(rule: string, filePath: string): void {
	const file = readSettingsFile(filePath) ?? {};
	const permissions = (file.permissions ??= {});
	const allow = (permissions.allow ??= []);
	if (!allow.includes(rule)) allow.push(rule);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`);
}

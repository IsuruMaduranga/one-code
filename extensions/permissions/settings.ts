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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PermissionMode } from "./matcher.ts";

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

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (MODES as string[]).includes(value);
}

function readSettingsFile(path: string): ClaudeSettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettingsFile;
	} catch {
		return undefined;
	}
}

export function settingsPaths(cwd: string, home: string): { user: string; project: string; local: string } {
	return {
		user: join(home, ".claude", "settings.json"),
		project: join(cwd, ".claude", "settings.json"),
		local: join(cwd, ".claude", "settings.local.json"),
	};
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
		if (isPermissionMode(perms.defaultMode)) merged.defaultMode = perms.defaultMode;
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

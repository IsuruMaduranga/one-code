/**
 * `autoMode` settings loading (pure fs), Claude Code compatible.
 *
 * ## Which files are read, and why that list is short
 *
 * User settings (`~/.claude/settings.json`) and managed settings only — **never
 * the project's `.claude/settings.json` or `.claude/settings.local.json`**. Both
 * live in the repository, so a checked-in file or a build step that writes one
 * could otherwise hand itself classifier allow rules and switch off the gate
 * that is meant to contain it. Claude Code made the same exclusion (it dropped
 * `settings.local.json` in v2.1.207); this is that property, not an omission.
 *
 * `"$defaults"` in any list splices the built-in rules in at that position, so
 * users keep inheriting updates. Omitting it replaces the list wholesale, which
 * is a real and occasionally correct choice — `/auto-mode config` shows the
 * result either way.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, DEFAULT_SOFT_DENY } from "./defaults.ts";

export interface AutoModeConfig {
	environment: string[];
	allow: string[];
	soft_deny: string[];
	hard_deny: string[];
	/** Suspend narrow Bash allow rules so every shell command reaches the classifier. */
	classifyAllShell: boolean;
	/** `provider/model-id` override for the classifier model. */
	classifierModel?: string;
}

interface AutoModeSettingsFile {
	autoMode?: {
		environment?: unknown;
		allow?: unknown;
		soft_deny?: unknown;
		hard_deny?: unknown;
		classifyAllShell?: unknown;
		classifierModel?: unknown;
	};
	[key: string]: unknown;
}

const DEFAULTS_TOKEN = "$defaults";

/** Managed-settings locations, highest authority, matching Claude Code's paths. */
function managedSettingsPaths(): string[] {
	if (process.platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
	if (process.platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
	return ["/etc/claude-code/managed-settings.json"];
}

/** The files `autoMode` is read from, lowest precedence first. */
export function autoModeSettingsPaths(home: string): string[] {
	return [join(home, ".claude", "settings.json"), ...managedSettingsPaths()];
}

function readFile(path: string): AutoModeSettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AutoModeSettingsFile;
	} catch {
		return undefined;
	}
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * Splice `$defaults` into a user list. Entries from separate scopes are
 * additive: a developer can extend a managed list but not remove from it.
 */
export function spliceDefaults(entries: string[] | undefined, defaults: string[]): string[] {
	if (!entries) return [...defaults];
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.trim() === DEFAULTS_TOKEN) out.push(...defaults);
		else out.push(entry);
	}
	return out;
}

export function loadAutoModeConfig(home: string): AutoModeConfig {
	const collected: {
		environment?: string[];
		allow?: string[];
		soft_deny?: string[];
		hard_deny?: string[];
		classifyAllShell?: boolean;
		classifierModel?: string;
	} = {};

	for (const path of autoModeSettingsPaths(home)) {
		const block = readFile(path)?.autoMode;
		if (!block) continue;
		for (const key of ["environment", "allow", "soft_deny", "hard_deny"] as const) {
			const parsed = stringArray(block[key]);
			// Additive across scopes: a later scope extends rather than replaces,
			// so managed entries cannot be dropped by a user file.
			if (parsed) collected[key] = [...(collected[key] ?? []), ...parsed];
		}
		if (typeof block.classifyAllShell === "boolean") collected.classifyAllShell = block.classifyAllShell;
		if (typeof block.classifierModel === "string" && block.classifierModel.trim()) {
			collected.classifierModel = block.classifierModel.trim();
		}
	}

	return {
		environment: spliceDefaults(collected.environment, DEFAULT_ENVIRONMENT),
		allow: spliceDefaults(collected.allow, DEFAULT_ALLOW),
		soft_deny: spliceDefaults(collected.soft_deny, DEFAULT_SOFT_DENY),
		hard_deny: spliceDefaults(collected.hard_deny, DEFAULT_HARD_DENY),
		classifyAllShell: collected.classifyAllShell ?? false,
		classifierModel: collected.classifierModel,
	};
}

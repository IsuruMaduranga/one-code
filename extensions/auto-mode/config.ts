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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	/** Append every gate decision to auto-mode-decisions.jsonl next to the session files. */
	logDecisions: boolean;
}

interface AutoModeSettingsFile {
	autoMode?: {
		environment?: unknown;
		allow?: unknown;
		soft_deny?: unknown;
		hard_deny?: unknown;
		classifyAllShell?: unknown;
		classifierModel?: unknown;
		logDecisions?: unknown;
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

function readFile(path: string, diagnostics: string[]): AutoModeSettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AutoModeSettingsFile;
	} catch (error) {
		// Swallowing this silently is how a user ends up believing rules are in
		// force that the gate never loaded — the file is still skipped (the gate
		// must not die on a typo), but the skip is reported.
		diagnostics.push(`${path}: invalid JSON, autoMode settings in it are ignored (${(error as Error).message})`);
		return undefined;
	}
}

const KNOWN_AUTO_MODE_KEYS = new Set([
	"environment",
	"allow",
	"soft_deny",
	"hard_deny",
	"classifyAllShell",
	"classifierModel",
	"logDecisions",
]);

const RULE_LIST_KEYS = ["environment", "allow", "soft_deny", "hard_deny"] as const;

/**
 * Shape problems in one file's `autoMode` block, as human-readable lines.
 * Purely advisory: loading stays lenient (a wrong-typed field is skipped, not
 * fatal), but skipped-because-mistyped must be visible in `/auto-mode config`
 * or it reads as the gate ignoring the user's settings.
 */
function validateAutoModeBlock(block: Record<string, unknown>, path: string, diagnostics: string[]): void {
	for (const key of Object.keys(block)) {
		if (!KNOWN_AUTO_MODE_KEYS.has(key)) diagnostics.push(`${path}: unknown autoMode key "${key}" is ignored`);
	}
	for (const key of RULE_LIST_KEYS) {
		const value = block[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) {
			diagnostics.push(`${path}: autoMode.${key} must be an array of strings — ignored`);
			continue;
		}
		for (const [position, entry] of value.entries()) {
			if (typeof entry !== "string" || entry.trim().length === 0) {
				diagnostics.push(`${path}: autoMode.${key}[${position}] is not a non-empty string — dropped`);
			}
		}
		const strings = value.filter((entry): entry is string => typeof entry === "string");
		if (strings.length > 0 && !strings.some((entry) => entry.trim() === DEFAULTS_TOKEN)) {
			diagnostics.push(
				`${path}: autoMode.${key} omits "${DEFAULTS_TOKEN}", so it REPLACES the built-in ${key} list rather than extending it`,
			);
		}
	}
	for (const key of ["classifyAllShell", "logDecisions"] as const) {
		if (block[key] !== undefined && typeof block[key] !== "boolean") {
			diagnostics.push(`${path}: autoMode.${key} must be a boolean — ignored`);
		}
	}
	if (
		block.classifierModel !== undefined &&
		(typeof block.classifierModel !== "string" || block.classifierModel.trim().length === 0)
	) {
		diagnostics.push(`${path}: autoMode.classifierModel must be a "provider/model-id" string — ignored`);
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

export interface AutoModeConfigLoad {
	config: AutoModeConfig;
	/** Problems found while loading, for `/auto-mode config`. Empty when clean. */
	diagnostics: string[];
}

export function loadAutoModeConfigWithDiagnostics(home: string): AutoModeConfigLoad {
	const diagnostics: string[] = [];
	const collected: {
		environment?: string[];
		allow?: string[];
		soft_deny?: string[];
		hard_deny?: string[];
		classifyAllShell?: boolean;
		classifierModel?: string;
		logDecisions?: boolean;
	} = {};

	for (const path of autoModeSettingsPaths(home)) {
		const file = readFile(path, diagnostics);
		const block = file?.autoMode;
		if (file !== undefined && "autoMode" in file && (typeof block !== "object" || block === null || Array.isArray(block))) {
			diagnostics.push(`${path}: autoMode must be an object — ignored`);
			continue;
		}
		if (!block) continue;
		validateAutoModeBlock(block as Record<string, unknown>, path, diagnostics);
		for (const key of ["environment", "allow", "soft_deny", "hard_deny"] as const) {
			const parsed = stringArray(block[key]);
			// Additive across scopes: a later scope extends rather than replaces,
			// so managed entries cannot be dropped by a user file.
			if (parsed) collected[key] = [...(collected[key] ?? []), ...parsed];
		}
		if (typeof block.classifyAllShell === "boolean") collected.classifyAllShell = block.classifyAllShell;
		if (typeof block.logDecisions === "boolean") collected.logDecisions = block.logDecisions;
		if (typeof block.classifierModel === "string" && block.classifierModel.trim()) {
			collected.classifierModel = block.classifierModel.trim();
		}
	}

	return {
		config: {
			environment: spliceDefaults(collected.environment, DEFAULT_ENVIRONMENT),
			allow: spliceDefaults(collected.allow, DEFAULT_ALLOW),
			soft_deny: spliceDefaults(collected.soft_deny, DEFAULT_SOFT_DENY),
			hard_deny: spliceDefaults(collected.hard_deny, DEFAULT_HARD_DENY),
			classifyAllShell: collected.classifyAllShell ?? false,
			classifierModel: collected.classifierModel,
			logDecisions: collected.logDecisions ?? false,
		},
		diagnostics,
	};
}

export function loadAutoModeConfig(home: string): AutoModeConfig {
	return loadAutoModeConfigWithDiagnostics(home).config;
}

/**
 * Persist `autoMode.classifierModel` in the *user* settings file, preserving
 * every other key. `undefined` removes the setting. Always user scope: this is
 * the knob that may move the classifier to another provider, so it lives where
 * only the user writes — never in a project file (see the module comment).
 *
 * Unlike loading, this throws on a malformed file: a lenient read merely skips
 * rules, but a lenient write would replace the user's whole settings file with
 * only ours.
 */
export function persistClassifierModel(spec: string | undefined, home: string): void {
	const path = join(home, ".claude", "settings.json");
	let file: Record<string, unknown> = {};
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${path}: root must be a JSON object`);
		}
		file = parsed as Record<string, unknown>;
	}
	const block =
		typeof file.autoMode === "object" && file.autoMode !== null && !Array.isArray(file.autoMode)
			? (file.autoMode as Record<string, unknown>)
			: {};
	if (spec === undefined) delete block.classifierModel;
	else block.classifierModel = spec;
	if (Object.keys(block).length === 0) delete file.autoMode;
	else file.autoMode = block;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

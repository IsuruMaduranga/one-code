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
import { type ConfigMode, claudeSourcesOn, configMode } from "./config-mode.ts";
import { claudeUserDir, oneCodeStateDir } from "./paths.ts";

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

/** Managed-settings locations, highest authority, matching Claude Code's paths. */
export function managedSettingsPaths(): string[] {
	if (process.platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
	if (process.platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
	return ["/etc/claude-code/managed-settings.json"];
}

/** Claude Code's `instructionFiles` values (findings §57); the default is `claude-md-or-agents-md`. */
export type InstructionFiles = "claude-md" | "claude-md-or-agents-md" | "claude-md-and-agents-md" | "managed-only";
const INSTRUCTION_FILES: readonly InstructionFiles[] = ["claude-md", "claude-md-or-agents-md", "claude-md-and-agents-md", "managed-only"];
const LEGACY_PROJECT_INSTRUCTIONS: Record<string, InstructionFiles> = {
	none: "managed-only",
	claude: "claude-md",
	"agents-fallback": "claude-md-or-agents-md",
	both: "claude-md-and-agents-md",
};
/** The AGENTS.md plugin's `pluginConfigs` keys: the id is inferred, so the bare name counts too. */
const AGENTS_MD_PLUGIN_KEYS = ["cc-plugin-agents-md@builtin", "cc-plugin-agents-md"];

/**
 * Claude Code's `instructionFiles` (findings §57): the AGENTS.md plugin's option
 * under `pluginConfigs[<id>].options`, from the user and managed settings
 * (Claude Code reads no project file for it), managed winning. The legacy
 * top-level `projectInstructions` applies only while `instructionFiles` is unset,
 * mapped as Claude Code maps it (an unknown string reads as `claude-md`).
 */
export function readInstructionFiles(home: string): InstructionFiles {
	let instructionFiles: InstructionFiles | undefined;
	let legacy: InstructionFiles | undefined;
	for (const path of [claudeUserSettingsPath(home), ...managedSettingsPaths()]) {
		const file = readSettingsFile(path);
		if (!file) continue;
		const configs = file.pluginConfigs as Record<string, { options?: Record<string, unknown> }> | undefined;
		for (const key of AGENTS_MD_PLUGIN_KEYS) {
			const value = configs?.[key]?.options?.instructionFiles;
			if (INSTRUCTION_FILES.includes(value as InstructionFiles)) instructionFiles = value as InstructionFiles;
		}
		if (typeof file.projectInstructions === "string") legacy = LEGACY_PROJECT_INSTRUCTIONS[file.projectInstructions] ?? "claude-md";
	}
	return instructionFiles ?? legacy ?? "claude-md-or-agents-md";
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
export function readSettingsEnv(home: string, mode: ConfigMode = configMode()): Record<string, string> {
	// Independent mode (lib/config-mode.ts) takes the block from One Code's user file.
	const path = claudeSourcesOn(mode) ? claudeUserSettingsPath(home) : join(oneCodeStateDir(process.env, home), "settings.json");
	const env = readSettingsFile(path)?.env;
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
export function readEnabledPlugins(cwd: string, home: string, mode: ConfigMode = configMode()): Record<string, boolean> {
	const merged: Record<string, boolean> = {};
	// Independent mode loads no Claude Code plugin install, so it reads no state for one.
	if (!claudeSourcesOn(mode)) return merged;
	const paths = settingsPaths(cwd, home);
	for (const path of [paths.user, paths.project, paths.local]) {
		const enabled = readSettingsFile(path)?.enabledPlugins;
		if (!enabled || typeof enabled !== "object") continue;
		for (const [key, value] of Object.entries(enabled)) {
			if (typeof value === "boolean") merged[key] = value;
		}
	}
	return merged;
}

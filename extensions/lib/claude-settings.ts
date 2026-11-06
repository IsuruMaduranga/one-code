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
import { join, posix, win32 } from "node:path";
import { openSources, type SettingsFile } from "./sources.ts";
import { oneCodeProjectSettingsPath, oneCodeSettingsPath } from "./one-code-settings.ts";
import { claudeManagedDir, claudeUserDir } from "./paths.ts";

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

/** Managed-settings locations, highest authority: `managed-settings.json` in Claude Code's managed root. */
export function managedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
	const { join: joinFor } = platform === "win32" ? win32 : posix;
	return [joinFor(claudeManagedDir(platform), "managed-settings.json")];
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

/**
 * The settings ladder, lowest precedence first: the product's own two files
 * (its user file and its per-project file in its state dir), as the source
 * provider reshapes them (lib/sources.ts `settings`). One Code's provider
 * adds Claude Code's user, project, local and managed files around them;
 * independent mode (lib/config-mode.ts) and a product without a provider
 * read the product's two alone. When no file is marked primary, the
 * product's user file is. Each consumer keeps the files its keys may come
 * from.
 */
export function settingsSources(cwd: string, home: string): SettingsFile[] {
	const base: SettingsFile[] = [
		{ path: oneCodeSettingsPath(home), scope: "user", owner: "product", label: "One Code user settings" },
		{ path: oneCodeProjectSettingsPath(cwd, home), scope: "local", owner: "product", label: "One Code project settings" },
	];
	const files = openSources(home).settings?.(base, { cwd }) ?? base;
	if (files.some((file) => file.primary)) return files;
	return files.map((file) => (file === base[0] ? { ...file, primary: true } : file));
}

/** The primary user file: the one holding the keys a user edits by hand (`SettingsFile.primary`). */
export function primarySettingsFile(files: readonly SettingsFile[]): SettingsFile | undefined {
	return files.find((file) => file.primary);
}

/** Whether the repository supplies this file: another tool's project or local file, which sits in the checkout. */
export function isRepoFile(file: SettingsFile): boolean {
	return file.owner === "borrowed" && (file.scope === "project" || file.scope === "local");
}

/** A stable id for a file's role, for keys and comparisons: `product-user`, `borrowed-local` and so on. */
export function sourceId(file: Pick<SettingsFile, "owner" | "scope">): string {
	return `${file.owner}-${file.scope}`;
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
	// The primary user file: Claude Code's with One Code's provider on, One Code's own without it.
	const primary = primarySettingsFile(settingsSources(process.cwd(), home));
	const env = primary ? readSettingsFile(primary.path)?.env : undefined;
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
	const merged: Record<string, boolean> = {};
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

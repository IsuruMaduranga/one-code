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
 * Code goes to the One Code plugin root (lib/plugins/plugin-overrides.ts), never here.
 */

import { brand } from "./brand.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { openSources, protectedFiles, type SettingsFile } from "./sources.ts";
import { productProjectSettingsPath, productSettingsPath } from "./product-settings.ts";
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

/**
 * The settings ladder, lowest precedence first: the product's own two files
 * (its user file and its per-project file in its state dir), as the source
 * provider reshapes them (lib/profile/sources.ts `settings`). One Code's provider
 * adds Claude Code's user, project, local and managed files around them;
 * independent mode (lib/profile/sources.ts) and a product without a provider
 * read the product's two alone. When no file is marked primary, the
 * product's user file is; a repository's file never is. Each consumer keeps the files its keys may come
 * from.
 */
export function settingsSources(cwd: string, home: string, opts: { productLocal?: boolean } = {}): SettingsFile[] {
	const base: SettingsFile[] = [
		{ path: productSettingsPath(home), scope: "user", owner: "product", label: `${brand.name} user settings` },
		// Finding it walks up for the project root: callers that want only user or borrowed files skip it.
		...(opts.productLocal === false ? [] : [{ path: productProjectSettingsPath(cwd, home), scope: "local", owner: "product", label: `${brand.name} project settings` } satisfies SettingsFile]),
	];
	// A repository's file is never the primary one: the keys read from it (MCP
	// approvals, defaultMode, env) would let a repository grant itself access.
	const files = (openSources(home).settings?.(base, { cwd }) ?? base).map((file) => (file.primary && file.repo ? { ...file, primary: false } : file));
	if (files.some((file) => file.primary)) return files;
	// Marked by role, not identity, so a provider may hand back copies of the base's entries.
	const own = files.findIndex((file) => file.owner === "product" && file.scope === "user" && !file.repo);
	return files.map((file, index) => (index === own ? { ...file, primary: true } : file));
}

/** The primary user file: the one holding the keys a user edits by hand (`SettingsFile.primary`). */
export function primarySettingsFile(files: readonly SettingsFile[]): SettingsFile | undefined {
	return files.find((file) => file.primary);
}

/** The primary file's family: the files of the same owner (Claude Code's four, or the product's two without a provider). */
export function primaryFamily(files: readonly SettingsFile[]): SettingsFile[] {
	const owner = primarySettingsFile(files)?.owner;
	return files.filter((file) => file.owner === owner);
}

/** Whether the repository supplies this file (`SettingsFile.repo`). */
export function isRepoFile(file: SettingsFile): boolean {
	return file.repo === true;
}

/** Another tool's user file: never the home of the product's own keys (`classifierModel`, `subagentModel`). */
export function isBorrowedUserFile(file: SettingsFile): boolean {
	return file.owner === "borrowed" && file.scope === "user";
}

/** A file's role as one id, for keys and comparisons. */
export type SourceId = `${SettingsFile["owner"]}-${SettingsFile["scope"]}`;

/** A stable id for a file's role: `product-user`, `borrowed-local` and so on. */
export function sourceId(file: Pick<SettingsFile, "owner" | "scope">): SourceId {
	return `${file.owner}-${file.scope}`;
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
 * (lib/shell-run/shell-spawn.ts). Project and local files are deliberately not merged —
 * a checked-in `env` that pointed the shell at a `tools/bash` inside the repo
 * would run that binary for every hook and background command, and the file
 * is the repository's, not the user's (Claude Code gates the same block behind
 * its project-trust prompt).
 */
export function readSettingsEnv(home: string): Record<string, string> {
	// The primary user file: Claude Code's with One Code's provider on, One Code's own without it.
	const primary = primarySettingsFile(settingsSources(process.cwd(), home, { productLocal: false }));
	const env = primary ? readSettingsFile(primary.path)?.env : undefined;
	if (!env || typeof env !== "object" || Array.isArray(env)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

/**
 * Another tool's plugin enabled-state map (`{"name@marketplace": boolean}`;
 * One Code's provider: Claude Code's), merged across the ladder's borrowed
 * user, project and local files — later files win per key.
 */
export function readEnabledPlugins(cwd: string, home: string): Record<string, boolean> {
	const merged: Record<string, boolean> = {};
	// The borrowed user, project and local files: the tool whose plugin root is read keeps its enabled state there.
	const borrowed = settingsSources(cwd, home, { productLocal: false }).filter((file) => file.owner === "borrowed" && file.scope !== "managed");
	for (const { path } of borrowed) {
		const enabled = readSettingsFile(path)?.enabledPlugins;
		if (!enabled || typeof enabled !== "object") continue;
		for (const [key, value] of Object.entries(enabled)) {
			if (typeof value === "boolean") merged[key] = value;
		}
	}
	return merged;
}

/**
 * The files that configure the permission gate for a session in `cwd`: the
 * settings ladder and the source provider's state files. The one list the
 * auto-mode floor and the protected paths share.
 */
export function gateControlFiles(cwd: string, home: string): string[] {
	return [...settingsSources(cwd, home).map((file) => file.path), ...protectedFiles(home).map((file) => file.path)];
}

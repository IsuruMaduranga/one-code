/**
 * Hook config discovery and merge (pure fs reads, no pi imports).
 *
 * Sources, in collection order: the primary settings file's family of the
 * ladder, user files first, then managed, then the repository's
 * (`hookSettingsPaths`; with One Code's provider on, Claude Code's four
 * files). Project and local sources are
 * *returned flagged, not filtered* — whether they run is a trust decision
 * (hooks are arbitrary code execution) that index.ts applies via trust.ts;
 * this module stays pure.
 *
 * Files are re-read only when their mtime changes: hook dispatch happens on
 * every tool call, so the cache keeps that to a stat() per source, while
 * config edits still land mid-session (unlike a session_start-only reload).
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { isRepoFile, primaryFamily, primarySettingsFile, settingsSources } from "../../lib/profile/claude-settings.ts";
import type { SettingsFile } from "../../lib/profile/sources.ts";
import { CC_HOOK_EVENTS, type CcHookEvent } from "../../lib/rules/hook-protocol.ts";

/** Claude Code's per-hook `shell` field: which interpreter runs the command string. */
export type HookShell = "bash" | "powershell";

export interface HookCommand {
	type: "command";
	command: string;
	/** Seconds, CC convention. */
	timeout?: number;
	/**
	 * Unset means the platform default: bash where one exists, PowerShell on
	 * Windows without Git Bash (Claude Code's rule — executor.ts `defaultHookShell`).
	 */
	shell?: HookShell;
}

export interface HookMatcherEntry {
	matcher?: string;
	hooks: HookCommand[];
}

export type HooksFileConfig = Partial<Record<CcHookEvent, HookMatcherEntry[]>>;

export type HookScope = "user" | "managed" | "project" | "local" | "plugin";

export interface HooksSource {
	scope: HookScope;
	path: string;
	pluginName?: string;
	config: HooksFileConfig;
}

export interface LoadedHooks {
	sources: HooksSource[];
	/** Configured sources are filtered; collectors must also suppress plugin hooks when set. */
	disabled?: "all" | "unmanaged";
	/** Malformed entries are skipped and reported, never fatal. */
	diagnostics: string[];
}

/**
 * The settings files hooks are read from, in collection order: the primary
 * user file's family of the ladder (lib/profile/claude-settings.ts settingsSources),
 * the user files first, then managed policy, then the repository's. With One
 * Code's provider on that is Claude Code's four files; without it, One
 * Code's user file and its per-repo file under `~/.onecode/projects/<slug>/`,
 * which no repository ships, so both are user scope and need no
 * project-trust prompt.
 */
export function hookSettingsPaths(cwd: string, home: string = os.homedir()): Array<{ scope: HookScope; path: string }> {
	// A file no repository ships is user scope, so it needs no project-trust prompt.
	const scopeOf = (file: SettingsFile): HookScope => (isRepoFile(file) || file.scope === "managed" ? file.scope : "user");
	// Runs on every hook dispatch: the product's per-project file (a walk up for
	// the project root) is looked up only when the product's files are the family.
	const borrowedFirst = settingsSources(cwd, home, { productLocal: false });
	const files = primarySettingsFile(borrowedFirst)?.owner === "borrowed" ? borrowedFirst : settingsSources(cwd, home);
	return primaryFamily(files)
		.map((file) => ({ scope: scopeOf(file), path: file.path }))
		.sort((a, b) => HOOK_SCOPE_ORDER.indexOf(a.scope) - HOOK_SCOPE_ORDER.indexOf(b.scope));
}

/** Claude Code's collection order: the user's files, managed policy, then the repository's. */
const HOOK_SCOPE_ORDER: readonly HookScope[] = ["user", "managed", "project", "local"];

/**
 * Validate one file's `hooks` block into HooksFileConfig. Unknown events,
 * non-command hook types, and shape errors become diagnostics, not throws —
 * a typo must not disable the rest of the user's hooks.
 */
export function parseHooksBlock(raw: unknown, origin: string, diagnostics: string[]): HooksFileConfig {
	const config: HooksFileConfig = {};
	if (raw === undefined || raw === null) return config;
	if (typeof raw !== "object") {
		diagnostics.push(`${origin}: "hooks" is not an object`);
		return config;
	}
	for (const [event, entries] of Object.entries(raw as Record<string, unknown>)) {
		if (!(CC_HOOK_EVENTS as readonly string[]).includes(event)) {
			diagnostics.push(`${origin}: unsupported hook event "${event}" skipped`);
			continue;
		}
		if (!Array.isArray(entries)) {
			diagnostics.push(`${origin}: ${event} is not an array`);
			continue;
		}
		const parsed: HookMatcherEntry[] = [];
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
				diagnostics.push(`${origin}: ${event} entry without a hooks array skipped`);
				continue;
			}
			const { matcher } = entry as { matcher?: unknown };
			const hooks: HookCommand[] = [];
			for (const hook of (entry as { hooks: unknown[] }).hooks) {
				const candidate = hook as { type?: unknown; command?: unknown; timeout?: unknown };
				if (candidate?.type !== "command" || typeof candidate.command !== "string" || !candidate.command.trim()) {
					diagnostics.push(`${origin}: ${event} hook of type "${String(candidate?.type)}" skipped (only "command" is supported)`);
					continue;
				}
				const { shell } = hook as { shell?: unknown };
				let hookShell: HookShell | undefined;
				if (shell !== undefined) {
					if (shell === "bash" || shell === "powershell") hookShell = shell;
					else diagnostics.push(`${origin}: ${event} hook shell "${String(shell)}" ignored (use "bash" or "powershell")`);
				}
				hooks.push({
					type: "command",
					command: candidate.command,
					timeout: typeof candidate.timeout === "number" && candidate.timeout > 0 ? candidate.timeout : undefined,
					shell: hookShell,
				});
			}
			if (hooks.length > 0) {
				parsed.push({ matcher: typeof matcher === "string" ? matcher : undefined, hooks });
			}
		}
		if (parsed.length > 0) config[event as CcHookEvent] = parsed;
	}
	return config;
}

interface CacheEntry {
	mtimeMs: number;
	config: HooksFileConfig;
	disableAllHooks?: boolean;
	diagnostics: string[];
}

const cache = new Map<string, CacheEntry>();

/** Read one settings file's hooks and disabling flag, via the mtime cache. */
function readHooksFile(path: string, diagnostics: string[]): CacheEntry | undefined {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		cache.delete(path);
		return undefined;
	}
	const cached = cache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) {
		diagnostics.push(...cached.diagnostics);
		return cached;
	}
	const fileDiagnostics: string[] = [];
	let config: HooksFileConfig = {};
	let disableAllHooks: boolean | undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { hooks?: unknown; disableAllHooks?: unknown };
		config = parseHooksBlock(parsed.hooks, path, fileDiagnostics);
		if (typeof parsed.disableAllHooks === "boolean") disableAllHooks = parsed.disableAllHooks;
	} catch (error) {
		fileDiagnostics.push(`${path}: unreadable settings file skipped (${error instanceof Error ? error.message : error})`);
	}
	const entry: CacheEntry = { mtimeMs, config, disableAllHooks, diagnostics: fileDiagnostics };
	cache.set(path, entry);
	diagnostics.push(...fileDiagnostics);
	return entry;
}

export function loadHookSettings(cwd: string, home: string = os.homedir()): LoadedHooks {
	const diagnostics: string[] = [];
	const sources: HooksSource[] = [];
	let userDisableAllHooks: boolean | undefined;
	let managedDisableAllHooks: boolean | undefined;
	let repoDisableAllHooks: boolean | undefined;
	for (const { scope, path } of hookSettingsPaths(cwd, home)) {
		const entry = readHooksFile(path, diagnostics);
		if (!entry) continue;
		if (entry.disableAllHooks !== undefined) {
			if (scope === "managed") managedDisableAllHooks = entry.disableAllHooks;
			else if (scope === "user") userDisableAllHooks = entry.disableAllHooks;
			else repoDisableAllHooks = entry.disableAllHooks;
		}
		if (Object.keys(entry.config).length > 0) sources.push({ scope, path, config: entry.config });
	}
	// Collection order stays stable, but managed booleans have highest precedence.
	// A non-managed disable must not turn off organization-managed hooks.
	if (managedDisableAllHooks === true) return { sources: [], diagnostics, disabled: "all" };
	if ((managedDisableAllHooks ?? userDisableAllHooks) === true) {
		return { sources: sources.filter((source) => source.scope === "managed"), diagnostics, disabled: "unmanaged" };
	}
	// A repository's flag reaches only its own hooks: a cloned repo must not
	// switch off the user's guard hooks, as project settings never set autoMode.
	if (managedDisableAllHooks === undefined && repoDisableAllHooks === true) {
		diagnostics.push("disableAllHooks in project settings turns off only the project's own hooks");
		return { sources: sources.filter((source) => source.scope === "user" || source.scope === "managed"), diagnostics };
	}
	return { sources, diagnostics };
}

/** Test seam: drop the mtime cache. */
export function resetHookSettingsCache(): void {
	cache.clear();
}

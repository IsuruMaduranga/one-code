/**
 * Hook config discovery and merge (pure fs reads, no pi imports).
 *
 * Sources, lowest authority first: user ~/.claude/settings.json, managed
 * settings (Claude Code's platform paths), project .claude/settings.json,
 * project .claude/settings.local.json. Project and local sources are
 * *returned flagged, not filtered* — whether they run is a trust decision
 * (hooks are arbitrary code execution) that index.ts applies via trust.ts;
 * this module stays pure.
 *
 * Files are re-read only when their mtime changes: hook dispatch happens on
 * every tool call, so the cache keeps that to a stat() per source, while
 * config edits still land mid-session (unlike a session_start-only reload).
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CC_HOOK_EVENTS, type CcHookEvent } from "./protocol.ts";

export interface HookCommand {
	type: "command";
	command: string;
	/** Seconds, CC convention. */
	timeout?: number;
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
	/** Malformed entries are skipped and reported, never fatal. */
	diagnostics: string[];
}

/** Managed-settings locations — Claude Code's exact per-platform paths. */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
	if (platform === "win32") return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
	return "/etc/claude-code/managed-settings.json";
}

export function hookSettingsPaths(claudeDir: string, cwd: string): Array<{ scope: HookScope; path: string }> {
	return [
		{ scope: "user", path: join(claudeDir, "settings.json") },
		{ scope: "managed", path: managedSettingsPath() },
		{ scope: "project", path: join(cwd, ".claude", "settings.json") },
		{ scope: "local", path: join(cwd, ".claude", "settings.local.json") },
	];
}

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
				hooks.push({
					type: "command",
					command: candidate.command,
					timeout: typeof candidate.timeout === "number" && candidate.timeout > 0 ? candidate.timeout : undefined,
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
	diagnostics: string[];
}

const cache = new Map<string, CacheEntry>();

/** Read one settings file's hooks block, via the mtime cache. */
function readHooksFile(path: string, diagnostics: string[]): HooksFileConfig | undefined {
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
		return cached.config;
	}
	const fileDiagnostics: string[] = [];
	let config: HooksFileConfig = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { hooks?: unknown };
		config = parseHooksBlock(parsed.hooks, path, fileDiagnostics);
	} catch (error) {
		fileDiagnostics.push(`${path}: unreadable settings file skipped (${error instanceof Error ? error.message : error})`);
	}
	cache.set(path, { mtimeMs, config, diagnostics: fileDiagnostics });
	diagnostics.push(...fileDiagnostics);
	return config;
}

export function loadHookSettings(claudeDir: string, cwd: string): LoadedHooks {
	const diagnostics: string[] = [];
	const sources: HooksSource[] = [];
	for (const { scope, path } of hookSettingsPaths(claudeDir, cwd)) {
		const config = readHooksFile(path, diagnostics);
		if (config && Object.keys(config).length > 0) sources.push({ scope, path, config });
	}
	return { sources, diagnostics };
}

/** Test seam: drop the mtime cache. */
export function resetHookSettingsCache(): void {
	cache.clear();
}

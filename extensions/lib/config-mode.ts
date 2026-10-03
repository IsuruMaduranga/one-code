/**
 * Where One Code reads its configuration and context: the two modes
 * (working-docs/features/config-modes/).
 *
 * - `claude-compatible` (the default): Claude Code's `~/.claude`,
 *   `<repo>/.claude`, `CLAUDE.md` and `~/.claude.json`, plus the cross-tool
 *   `AGENTS.md` and `.agents/skills` and pi's own directories.
 * - `independent`: no Claude Code path at all; `~/.onecode`, `ONECODE.md`,
 *   `<repo>/.onecode/`, pi's directories and the cross-tool files, with
 *   auto-memory under `~/.onecode/projects/<slug>/memory/`.
 *
 * The choice is `configMode` in One Code's user settings
 * (`~/.onecode/settings.json`), never read from `~/.claude`;
 * `ONECODE_CONFIG_MODE` overrides it. Readers run at factory time and on
 * `resources_discover`, before any session event, so the mode is read from
 * disk, not broadcast.
 *
 * The mode is fixed for the life of the process: the first read pins it in a
 * `globalThis` slot that every extension's module instance shares (jiti gives
 * each its own copy of this file). The system prompt names the memory folder
 * and must stay byte-stable, so a `/memory` toggle saves the setting and
 * applies from the next start.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { oneCodeStateDir } from "./paths.ts";

export type ConfigMode = "claude-compatible" | "independent";

export const CONFIG_MODES: readonly ConfigMode[] = ["claude-compatible", "independent"];
export const DEFAULT_CONFIG_MODE: ConfigMode = "claude-compatible";

/** The key in `~/.onecode/settings.json`. */
export const CONFIG_MODE_KEY = "configMode";
export const CONFIG_MODE_ENV = "ONECODE_CONFIG_MODE";

export function isConfigMode(value: unknown): value is ConfigMode {
	return value === "claude-compatible" || value === "independent";
}

/**
 * The saved mode: `ONECODE_CONFIG_MODE`, else `configMode` in One Code's user
 * settings, else the default. A missing, malformed or unknown value reads as
 * the default (fail toward today's behaviour); an unknown env value is ignored.
 */
export function readConfigMode(home: string = os.homedir(), env: Record<string, string | undefined> = process.env): ConfigMode {
	const fromEnv = env[CONFIG_MODE_ENV];
	if (isConfigMode(fromEnv)) return fromEnv;
	return savedConfigMode(home, env);
}

/** `configMode` in `~/.onecode/settings.json` alone, ignoring the env override. */
export function savedConfigMode(home: string = os.homedir(), env: Record<string, string | undefined> = process.env): ConfigMode {
	try {
		const parsed = JSON.parse(readFileSync(join(oneCodeStateDir(env, home), "settings.json"), "utf8")) as unknown;
		const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[CONFIG_MODE_KEY] : undefined;
		return isConfigMode(value) ? value : DEFAULT_CONFIG_MODE;
	} catch {
		return DEFAULT_CONFIG_MODE;
	}
}

const MODE_SLOT = Symbol.for("one-code:config-mode");

/**
 * The mode this process runs in: read once, then pinned for every extension.
 * Tests that need a different mode call `resetConfigModeForTest` first.
 */
export function configMode(): ConfigMode {
	const slot = globalThis as { [MODE_SLOT]?: ConfigMode };
	return (slot[MODE_SLOT] ??= readConfigMode());
}

export function resetConfigModeForTest(mode?: ConfigMode): void {
	const slot = globalThis as { [MODE_SLOT]?: ConfigMode };
	if (mode) slot[MODE_SLOT] = mode;
	else delete slot[MODE_SLOT];
}

/** Whether Claude Code's own locations are read: `~/.claude`, `.claude/`, `CLAUDE.md`, `~/.claude.json`. */
export function claudeSourcesOn(mode: ConfigMode = configMode()): boolean {
	return mode === "claude-compatible";
}

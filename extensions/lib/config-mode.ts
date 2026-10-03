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

import os from "node:os";
import { join } from "node:path";
import { readJsonFile } from "./atomic-write.ts";
import { claudeUserDir, oneCodeStateDir } from "./paths.ts";

export type ConfigMode = "claude-compatible" | "independent";

const DEFAULT_CONFIG_MODE: ConfigMode = "claude-compatible";

/** How each mode is named to the user (`/memory`, `/doctor`). */
export const MODE_LABELS: Record<ConfigMode, string> = {
	"claude-compatible": "Claude-compatible",
	independent: "Independent",
};

/** The key in `~/.onecode/settings.json`. */
export const CONFIG_MODE_KEY = "configMode";
const CONFIG_MODE_ENV = "ONECODE_CONFIG_MODE";

function isConfigMode(value: unknown): value is ConfigMode {
	return value === "claude-compatible" || value === "independent";
}

/**
 * The saved mode: `ONECODE_CONFIG_MODE`, else `configMode` in One Code's user
 * settings, else the default. A missing, malformed or unknown value reads as
 * the default (fail toward today's behaviour); an unknown env value is ignored.
 */
export function readConfigMode(home: string = os.homedir(), env: Record<string, string | undefined> = process.env): ConfigMode {
	return configModeFromEnv(env) ?? savedConfigMode(home, env);
}

/** The mode `ONECODE_CONFIG_MODE` sets, or undefined when it is unset or unknown. */
export function configModeFromEnv(env: Record<string, string | undefined> = process.env): ConfigMode | undefined {
	const value = env[CONFIG_MODE_ENV];
	return isConfigMode(value) ? value : undefined;
}

/**
 * `configMode` in `~/.onecode/settings.json` alone, ignoring the env override.
 * The path is spelled out: importing `oneCodeSettingsPath` would cycle through
 * `one-code-settings.ts` and `memory.ts`.
 */
export function savedConfigMode(home: string = os.homedir(), env: Record<string, string | undefined> = process.env): ConfigMode {
	const value = readJsonFile<Record<string, unknown>>(join(oneCodeStateDir(env, home), "settings.json"))?.[CONFIG_MODE_KEY];
	return isConfigMode(value) ? value : DEFAULT_CONFIG_MODE;
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
export function claudeSourcesOn(): boolean {
	return configMode() === "claude-compatible";
}

/**
 * The user-level folder that holds agents, commands, workflows and the user
 * settings file: `~/.claude` (`CLAUDE_CONFIG_DIR`) in Claude-compatible mode,
 * `~/.onecode` (`ONECODE_STATE_DIR`) in independent mode.
 */
export function userConfigDir(home: string, env: Record<string, string | undefined> = process.env): string {
	return claudeSourcesOn() ? claudeUserDir(home, env) : oneCodeStateDir(env, home);
}

/** The project-level folder's name: `.claude`, or `.onecode` in independent mode. */
export function projectConfigDirName(): string {
	return claudeSourcesOn() ? ".claude" : ".onecode";
}

/** The project-level counterpart of `userConfigDir`: `<cwd>/.claude` or `<cwd>/.onecode`. */
export function projectConfigDir(cwd: string): string {
	return join(cwd, projectConfigDirName());
}

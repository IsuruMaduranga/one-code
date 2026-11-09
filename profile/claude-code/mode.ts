/**
 * One Code's config mode, the state of its source provider's switch
 * (sources.ts, "Config sources"; working-docs/features/config-modes/). The
 * base never asks it: it sees the provider's view and switch
 * (extensions/lib/profile/sources.ts).
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
import { envName, productSettingsPath, readJsonFile } from "../../extensions/sdk/source-provider.ts";
import { pinConfigMode, pinnedConfigMode } from "./mode-slot.ts";

export { resetConfigModeForTest } from "./mode-slot.ts";

export type ConfigMode = "claude-compatible" | "independent";

const DEFAULT_CONFIG_MODE: ConfigMode = "claude-compatible";

/** The key in `~/.onecode/settings.json`. */
export const CONFIG_MODE_KEY = "configMode";
export const CONFIG_MODE_ENV = envName("CONFIG_MODE");

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

/** `configMode` in `~/.onecode/settings.json` alone, ignoring the env override. */
export function savedConfigMode(home: string = os.homedir(), env: Record<string, string | undefined> = process.env): ConfigMode {
	const value = readJsonFile<Record<string, unknown>>(productSettingsPath(home, env))?.[CONFIG_MODE_KEY];
	return isConfigMode(value) ? value : DEFAULT_CONFIG_MODE;
}

/**
 * The mode this process runs in: read once, then pinned for every extension
 * (mode-slot.ts). Tests that need a different mode call `resetConfigModeForTest` first.
 */
export function configMode(): ConfigMode {
	return pinnedConfigMode() ?? pinConfigMode(readConfigMode());
}

/** Whether Claude Code's own locations are read: `~/.claude`, `.claude/`, `CLAUDE.md`, `~/.claude.json`. */
export function claudeSourcesOn(): boolean {
	return configMode() === "claude-compatible";
}

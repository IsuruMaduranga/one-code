/**
 * Whether auto-memory is on: Claude Code's `autoMemoryEnabled` setting and its
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` override (pure fs, no pi imports).
 *
 * Off means the system prompt has no memory section, the MEMORY.md index is
 * not loaded, and the memory folder is neither created nor offered by
 * `/memory`. The `/memory` panel's "Auto-memory" row toggles the setting in
 * One Code's user settings. The value is read once and pinned for the
 * process, like the config mode: the system prompt must stay byte-stable, so
 * a change applies from the next start.
 */

import { envName } from "./brand.mjs";
import { knobValue, readKnob } from "./knobs.ts";
import { brandedId } from "./brand.mjs";
import { featureEnabled } from "./profile.ts";
import os from "node:os";
import { readSettingsFile, settingsSources } from "./claude-settings.ts";

/** The settings key, as Claude Code spells it. */
export const AUTO_MEMORY_KEY = "autoMemoryEnabled";
/** The knob that overrides the setting (lib/knobs.ts): `<envPrefix>_DISABLE_AUTO_MEMORY`, or the provider's alias. */
export const AUTO_MEMORY_KNOB = "DISABLE_AUTO_MEMORY";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * What the `DISABLE_AUTO_MEMORY` knob decides: a truthy value turns
 * auto-memory off, a defined falsy one forces it on, anything else leaves it
 * to the settings.
 */
export function autoMemoryFromEnv(env: Record<string, string | undefined> = process.env): boolean | undefined {
	const raw = knobValue(AUTO_MEMORY_KNOB, env)?.trim().toLowerCase();
	if (raw === undefined || raw === "") return undefined;
	if (TRUTHY.has(raw)) return false;
	if (FALSY.has(raw)) return true;
	return undefined;
}

/** The variable that sets auto-memory in `env`, else the product's own spelling, for messages. */
export function autoMemoryEnvVar(env: Record<string, string | undefined> = process.env): string {
	return readKnob(AUTO_MEMORY_KNOB, env)?.name ?? envName(AUTO_MEMORY_KNOB);
}

/**
 * `autoMemoryEnabled` from the settings ladder the mode reads (the last file
 * that sets it wins, managed policy last), ignoring the env override.
 * Default on.
 */
export function savedAutoMemory(cwd: string, home: string = os.homedir()): boolean {
	return savedAutoMemorySource(cwd, home).enabled;
}

/** `savedAutoMemory` and the settings file that decides it (undefined: the default). */
export function savedAutoMemorySource(cwd: string, home: string = os.homedir()): { enabled: boolean; path?: string } {
	let decided: { enabled: boolean; path?: string } = { enabled: true };
	for (const { path } of settingsSources(cwd, home)) {
		const value = readSettingsFile(path)?.[AUTO_MEMORY_KEY];
		if (typeof value === "boolean") decided = { enabled: value, path };
	}
	return decided;
}

export function readAutoMemory(cwd: string, home: string = os.homedir(), env: Record<string, string | undefined> = process.env): boolean {
	return autoMemoryFromEnv(env) ?? savedAutoMemory(cwd, home);
}

const AUTO_MEMORY_SLOT = Symbol.for(brandedId("auto-memory"));

/**
 * Whether auto-memory is on for this process: read once (for the first
 * session's cwd), then pinned for every extension. Tests that need the other
 * value call `resetAutoMemoryForTest` first.
 */
export function autoMemoryEnabled(cwd: string = process.cwd()): boolean {
	// The profile's memory feature off means no auto-memory anywhere: no prompt
	// section, no MEMORY.md in message 1, no writable memory dir (lib/profile.ts).
	if (!featureEnabled("memory")) return false;
	const slot = globalThis as { [AUTO_MEMORY_SLOT]?: boolean };
	return (slot[AUTO_MEMORY_SLOT] ??= readAutoMemory(cwd));
}

export function resetAutoMemoryForTest(enabled?: boolean): void {
	const slot = globalThis as { [AUTO_MEMORY_SLOT]?: boolean };
	if (enabled === undefined) delete slot[AUTO_MEMORY_SLOT];
	else slot[AUTO_MEMORY_SLOT] = enabled;
}

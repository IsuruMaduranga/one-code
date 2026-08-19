/**
 * Per-skill availability overrides (pure fs, no pi imports).
 *
 * `<plugin root>/skill-overrides.json`: `{"<scope>:<skill name>": SkillState}`.
 * Mirrors Claude Code's `skillOverrides` setting — four states controlling how
 * much of a skill reaches the model and whether the user can still run it:
 *
 *   on         name + description listed to the model; user-invocable
 *   name-only  name listed (no description, saving context tokens); user-invocable
 *   user-only  hidden from the model (won't auto-trigger); user-invocable via /name
 *   off        hidden from the model AND refused on explicit invocation
 *
 * Absent key = "on" (every discovered skill is fully available by default). The
 * /skills panel cycles these states for project/user skills; plugin skills are
 * "locked" (their on/off is managed via /plugins, stored here under the
 * "plugin" scope as on/off only). Legacy boolean values round-trip as on/off.
 *
 * The boolean-facing `isSkillEnabled`/`setSkillOverride` wrappers keep the
 * /plugins panel and the plugin-skill filter (which only ever enable/disable)
 * working against the same store.
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-write.ts";

const FILE = "skill-overrides.json";

export type SkillScope = "user" | "project" | "plugin";
export type SkillState = "on" | "name-only" | "user-only" | "off";

/** Cycle order for the /skills panel (space/enter advances). */
export const SKILL_STATES: readonly SkillState[] = ["on", "name-only", "user-only", "off"];

export function skillOverrideKey(scope: SkillScope, name: string): string {
	return `${scope}:${name}`;
}

/** Read the store as states, coercing legacy booleans (true → on, false → off). */
export function readSkillStates(root: string): Record<string, SkillState> {
	const parsed = readJsonFile<Record<string, unknown>>(join(root, FILE));
	if (!parsed || typeof parsed !== "object") return {};
	const map: Record<string, SkillState> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string" && (SKILL_STATES as readonly string[]).includes(value)) {
			map[key] = value as SkillState;
		} else if (value === true) {
			map[key] = "on";
		} else if (value === false) {
			map[key] = "off";
		}
	}
	return map;
}

export function setSkillState(root: string, key: string, state: SkillState): void {
	const existing = readJsonFile<Record<string, unknown>>(join(root, FILE)) ?? {};
	writeJsonAtomic(join(root, FILE), { ...existing, [key]: state });
}

export function skillStateFor(states: Record<string, SkillState>, key: string): SkillState {
	return states[key] ?? "on";
}

/** Advance to the next state in the cycle (wraps). */
export function nextSkillState(state: SkillState): SkillState {
	return SKILL_STATES[(SKILL_STATES.indexOf(state) + 1) % SKILL_STATES.length];
}

/** How much of the skill the model's listing should carry for a given state. */
export function skillListingVisibility(state: SkillState): "full" | "name" | "hidden" {
	return state === "on" ? "full" : state === "name-only" ? "name" : "hidden";
}

// --- Boolean-facing compatibility (plugins panel + plugin-skill filter) ---

/** Enabled = anything but "off"; the plugin filter and Installed tab use this. */
export function isSkillEnabled(states: Record<string, SkillState>, key: string): boolean {
	return skillStateFor(states, key) !== "off";
}

export function setSkillOverride(root: string, key: string, enabled: boolean): void {
	setSkillState(root, key, enabled ? "on" : "off");
}




/**
 * Per-skill enable/disable overrides (pure fs, no pi imports).
 *
 * `<plugin root>/skill-overrides.json`: `{"<scope>:<skill name>": boolean}`.
 * Absent key = enabled (matching today's behavior where every discovered
 * skill is usable). The skill extension filters its index by this store and
 * refuses to execute a disabled skill; the /plugins panel toggles it.
 */

import { join } from "node:path";
import { readBooleanMap, setBooleanMapEntry } from "./atomic-write.ts";

const FILE = "skill-overrides.json";

export type SkillScope = "user" | "project" | "plugin";

export function skillOverrideKey(scope: SkillScope, name: string): string {
	return `${scope}:${name}`;
}

export function readSkillOverrides(root: string): Record<string, boolean> {
	return readBooleanMap(join(root, FILE));
}

export function setSkillOverride(root: string, key: string, enabled: boolean): void {
	setBooleanMapEntry(join(root, FILE), key, enabled);
}

export function isSkillEnabled(overrides: Record<string, boolean>, key: string): boolean {
	return overrides[key] ?? true;
}

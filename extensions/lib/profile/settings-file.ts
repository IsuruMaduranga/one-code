/**
 * Where One Code's user settings file is, and the one key the profile reads
 * from it while it resolves (`featuresOff`). A leaf: lib/profile/profile.ts
 * imports it, and product-settings.ts (which reaches the profile through the
 * memory and source modules) cannot be imported there.
 */

import { join } from "node:path";
import { readJsonFile } from "../core/atomic-write.ts";
import { productStateDir } from "./paths.ts";

/** `~/.onecode/settings.json`: the product's user-scope settings (writable). */
export function productSettingsPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(productStateDir(env, home), "settings.json");
}

/**
 * The features the user turned off in their settings file (`featuresOff`,
 * written by /config). Lenient: a missing or malformed file, or a value that
 * is not a list of names, turns nothing off. Never read from a project's
 * files: what a cloned repository ships must not change the session.
 */
export function readFeaturesOffSetting(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const file = readJsonFile<unknown>(productSettingsPath(home, env));
	return file && typeof file === "object" ? featuresOffOf(file as Record<string, unknown>) : [];
}

/** A settings object's `featuresOff`: its names, trimmed, without empty ones; none when it is not a list. */
export function featuresOffOf(file: Record<string, unknown>): string[] {
	const value = file.featuresOff;
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()) : [];
}

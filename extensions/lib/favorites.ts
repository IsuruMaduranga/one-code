/**
 * Favorited plugins/skills for the /plugins panel (pure fs, no pi imports).
 *
 * `<plugin root>/favorites.json`: `{plugins: string[], skills: string[]}`.
 * Favorited rows float to the top of the Installed tab.
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-write.ts";

const FILE = "favorites.json";

export interface Favorites {
	plugins: string[];
	skills: string[];
}

export type FavoriteKind = "plugin" | "skill";

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function readFavorites(root: string): Favorites {
	const parsed = readJsonFile<{ plugins?: unknown; skills?: unknown }>(join(root, FILE));
	return { plugins: strings(parsed?.plugins), skills: strings(parsed?.skills) };
}

/** Toggle; returns the new favorited state. */
export function toggleFavorite(root: string, kind: FavoriteKind, key: string): boolean {
	const path = join(root, FILE);
	const existing = readJsonFile<Record<string, unknown>>(path) ?? {};
	const current: Favorites = { plugins: strings(existing.plugins), skills: strings(existing.skills) };
	const list = kind === "plugin" ? current.plugins : current.skills;
	const favorited = !list.includes(key);
	const next = favorited ? [...list, key] : list.filter((k) => k !== key);
	writeJsonAtomic(path, {
		...existing,
		plugins: kind === "plugin" ? next : current.plugins,
		skills: kind === "skill" ? next : current.skills,
	});
	return favorited;
}

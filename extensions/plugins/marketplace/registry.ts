/**
 * known_marketplaces.json under the One Code plugin root (pure fs).
 *
 * `{"<name>": {source, installLocation, lastUpdated, autoUpdate?}}` — the same
 * shape Claude Code keeps, but in our own root; Claude Code's copy is never
 * read or written (a claude-origin plugin's marketplace name already rides in
 * its `name@marketplace` id, so nothing is lost).
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../lib/atomic-write.ts";
import { sanitizePathSegment } from "../../lib/plugin-root.ts";
import { type KnownMarketplace, parseKnownMarketplace } from "./types.ts";

const FILE = "known_marketplaces.json";

export function knownMarketplacesPath(root: string): string {
	return join(root, FILE);
}

export function readKnownMarketplaces(root: string): Record<string, KnownMarketplace> {
	const raw = readJsonFile<Record<string, unknown>>(knownMarketplacesPath(root));
	if (!raw || typeof raw !== "object") return {};
	const marketplaces: Record<string, KnownMarketplace> = {};
	for (const [name, value] of Object.entries(raw)) {
		const parsed = parseKnownMarketplace(value);
		if (parsed) marketplaces[name] = parsed;
	}
	return marketplaces;
}

export function writeKnownMarketplace(root: string, name: string, entry: KnownMarketplace): void {
	const path = knownMarketplacesPath(root);
	const existing = readJsonFile<Record<string, unknown>>(path) ?? {};
	writeJsonAtomic(path, { ...existing, [name]: entry });
}

export function removeKnownMarketplace(root: string, name: string): void {
	const path = knownMarketplacesPath(root);
	const existing = readJsonFile<Record<string, unknown>>(path);
	if (!existing || !(name in existing)) return;
	const { [name]: _removed, ...rest } = existing;
	writeJsonAtomic(path, rest);
}

/**
 * A registry name not yet taken, suffixing -2, -3, … on collision. The name
 * becomes a path segment under marketplaces/ (and is rm'd on removal), so it
 * is sanitized here — the one entry point every registration goes through —
 * or a shorthand like `x/..` would name a marketplace `..`.
 */
export function availableMarketplaceName(root: string, suggested: string): string {
	const safe = sanitizePathSegment(suggested);
	const taken = new Set(Object.keys(readKnownMarketplaces(root)));
	if (!taken.has(safe)) return safe;
	for (let i = 2; ; i++) {
		const candidate = `${safe}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

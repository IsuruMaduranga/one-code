/**
 * The official Claude Code plugin marketplace (Apache-2.0 GitHub repository).
 *
 * Registered lazily on the first /plugins open — never at session start — and
 * refreshed when its clone is older than a day. Content comes from GitHub
 * only; no other endpoints are used.
 */

import { readKnownMarketplaces, writeKnownMarketplace } from "./registry.ts";
import type { KnownMarketplace } from "./types.ts";

export const OFFICIAL_MARKETPLACE_NAME = "claude-plugins-official";

export const OFFICIAL_MARKETPLACE_SOURCE = { source: "github", repo: "anthropics/claude-plugins-official" } as const;

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Register the official marketplace in our root when absent; returns its entry. */
export function ensureOfficialRegistered(root: string, installLocation: string): KnownMarketplace {
	const existing = readKnownMarketplaces(root)[OFFICIAL_MARKETPLACE_NAME];
	if (existing) return existing;
	const entry: KnownMarketplace = {
		source: OFFICIAL_MARKETPLACE_SOURCE,
		installLocation,
		lastUpdated: new Date(0).toISOString(),
		autoUpdate: true,
	};
	writeKnownMarketplace(root, OFFICIAL_MARKETPLACE_NAME, entry);
	return entry;
}

export function isStale(known: KnownMarketplace, now: Date = new Date()): boolean {
	const last = Date.parse(known.lastUpdated);
	if (Number.isNaN(last)) return true;
	return now.getTime() - last > STALE_AFTER_MS;
}

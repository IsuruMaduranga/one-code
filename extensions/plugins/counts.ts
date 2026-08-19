/**
 * Install counts for the Discover tab.
 *
 * Public stats JSON from the official marketplace repository
 * (`[{plugin: "name@marketplace", unique_installs}]`), cached under the plugin
 * root for 24h. A fetch failure hides counts (undefined) — never shows zeros.
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../lib/atomic-write.ts";
import { fetchWithTimeout } from "../lib/fetch-timeout.ts";

export const INSTALL_COUNTS_URL =
	"https://raw.githubusercontent.com/anthropics/claude-plugins-official/refs/heads/stats/stats/plugin-installs.json";

const CACHE_FILE = "install-counts-cache.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface CountsCache {
	version: 1;
	fetchedAt: string;
	counts: Array<{ plugin: string; unique_installs: number }>;
}

function toMap(counts: CountsCache["counts"]): Map<string, number> {
	const map = new Map<string, number>();
	for (const entry of counts) {
		if (typeof entry?.plugin === "string" && typeof entry?.unique_installs === "number") {
			map.set(entry.plugin, entry.unique_installs);
		}
	}
	return map;
}

/** Fresh cached counts, or undefined when absent/expired/malformed. */
export function readCachedCounts(root: string, now: Date = new Date()): Map<string, number> | undefined {
	const cache = readJsonFile<CountsCache>(join(root, CACHE_FILE));
	if (!cache || !Array.isArray(cache.counts) || typeof cache.fetchedAt !== "string") return undefined;
	const fetchedAt = Date.parse(cache.fetchedAt);
	if (Number.isNaN(fetchedAt) || now.getTime() - fetchedAt > CACHE_TTL_MS) return undefined;
	return toMap(cache.counts);
}

/** Cached counts when fresh, else fetch + cache; undefined on failure. */
export async function fetchInstallCounts(root: string, now: Date = new Date()): Promise<Map<string, number> | undefined> {
	const cached = readCachedCounts(root, now);
	if (cached) return cached;

	try {
		const response = await fetchWithTimeout(INSTALL_COUNTS_URL, FETCH_TIMEOUT_MS);
		if (!response.ok) return undefined;
		const counts = (await response.json()) as CountsCache["counts"];
		if (!Array.isArray(counts)) return undefined;
		writeJsonAtomic(join(root, CACHE_FILE), { version: 1, fetchedAt: now.toISOString(), counts } satisfies CountsCache);
		return toMap(counts);
	} catch {
		return undefined;
	}
}

/** 999 → "999", 36400 → "36.4K", 1_200_000 → "1.2M" (trailing .0 stripped). */
export function formatInstallCount(count: number): string {
	if (count < 1000) return String(count);
	const scaled = count < 1_000_000 ? count / 1000 : count / 1_000_000;
	const suffix = count < 1_000_000 ? "K" : "M";
	return `${scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

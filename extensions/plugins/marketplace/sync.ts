/**
 * Marketplace content sync: make a registered marketplace's manifest readable
 * locally (clone/fetch/read per source type) and parse it into a snapshot.
 *
 * Network and git run only from explicit panel actions (open/refresh/add) —
 * never at session start.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../lib/atomic-write.ts";
import { fetchWithTimeout } from "../../lib/fetch-timeout.ts";
import { gitClone, gitUpdate } from "./git.ts";
import { writeKnownMarketplace } from "./registry.ts";
import {
	type KnownMarketplace,
	type MarketplaceManifest,
	type MarketplaceSource,
	parseMarketplaceManifest,
} from "./types.ts";

export interface MarketplaceSnapshot {
	name: string;
	known: KnownMarketplace;
	manifest?: MarketplaceManifest;
	errors: string[];
	/** Directory plugin `./relative` sources resolve against (clone/local root). */
	contentRoot?: string;
}

export function marketplaceCacheDir(root: string): string {
	return join(root, "marketplaces");
}

/** Where a source's content lives under our root (clone dir or cached .json). */
export function installLocationFor(root: string, name: string, source: MarketplaceSource): string {
	return source.source === "url" ? join(marketplaceCacheDir(root), `${name}.json`) : join(marketplaceCacheDir(root), name);
}

function cloneUrl(source: MarketplaceSource): string | undefined {
	if (source.source === "github") return `https://github.com/${source.repo}.git`;
	if (source.source === "git") return source.url;
	return undefined;
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchManifestJson(url: string): Promise<unknown> {
	const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, { headers: { "user-agent": "one-code-plugins" } });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return await response.json();
}

/**
 * Ensure the marketplace's content is present (clone/fetch when missing,
 * update when `refresh`), then parse its manifest. Errors are reported in the
 * snapshot, never thrown — offline opens degrade to whatever is cached.
 */
export async function syncMarketplace(
	root: string,
	name: string,
	known: KnownMarketplace,
	options: { refresh?: boolean } = {},
): Promise<MarketplaceSnapshot> {
	const errors: string[] = [];
	const { source } = known;
	let manifestPath: string | undefined;
	let contentRoot: string | undefined;
	let synced = false;

	const url = cloneUrl(source);
	if (url) {
		const dest = installLocationFor(root, name, source);
		try {
			if (!existsSync(dest)) {
				await gitClone(url, dest, { ref: source.source === "github" || source.source === "git" ? source.ref : undefined });
				synced = true;
			} else if (options.refresh) {
				try {
					await gitUpdate(dest, { ref: source.source === "github" || source.source === "git" ? source.ref : undefined });
				} catch {
					// In-place update failed (force-push, sparse transition, corrupt
					// clone): re-clone from scratch rather than serving a broken tree.
					// The existing clone stays in place until the replacement clone
					// succeeds — gitClone builds in a temp dir and renames over dest,
					// so a failed re-clone keeps serving the stale content.
					await gitClone(url, dest, { ref: source.source === "github" || source.source === "git" ? source.ref : undefined });
				}
				synced = true;
			}
		} catch (error) {
			errors.push(`${name}: ${(error as Error).message}`);
		}
		if (existsSync(dest)) {
			contentRoot = dest;
			manifestPath = join(dest, ".claude-plugin", "marketplace.json");
		}
	} else if (source.source === "url") {
		const cache = installLocationFor(root, name, source);
		if (!existsSync(cache) || options.refresh) {
			try {
				const fetched = await fetchManifestJson(source.url);
				const validated = parseMarketplaceManifest(fetched);
				if (!validated.manifest) {
					errors.push(...validated.errors.map((e) => `${name}: ${e}`));
				} else {
					writeJsonAtomic(cache, fetched);
					synced = true;
				}
			} catch (error) {
				errors.push(`${name}: could not fetch ${source.url} (${(error as Error).message})`);
			}
		}
		if (existsSync(cache)) manifestPath = cache;
	} else if (source.source === "file") {
		manifestPath = source.path;
		contentRoot = join(source.path, "..", "..");
	} else if (source.source === "directory") {
		contentRoot = source.path;
		manifestPath = join(source.path, ".claude-plugin", "marketplace.json");
	}

	let manifest: MarketplaceManifest | undefined;
	if (manifestPath && existsSync(manifestPath) && statSync(manifestPath).isFile()) {
		const raw = readJsonFile<unknown>(manifestPath);
		if (raw === undefined) {
			errors.push(`${name}: ${manifestPath} is not valid JSON`);
		} else {
			const validated = parseMarketplaceManifest(raw);
			manifest = validated.manifest;
			errors.push(...validated.errors.map((e) => `${name}: ${e}`));
		}
	} else if (errors.length === 0) {
		errors.push(`${name}: no marketplace.json found${manifestPath ? ` at ${manifestPath}` : ""}`);
	}

	// Return the post-write entry so callers can update their in-memory
	// registry copy instead of re-reading known_marketplaces.json.
	let updatedKnown = known;
	if (synced) {
		updatedKnown = { ...known, lastUpdated: new Date().toISOString() };
		writeKnownMarketplace(root, name, updatedKnown);
	}

	return { name, known: updatedKnown, manifest, errors, contentRoot };
}

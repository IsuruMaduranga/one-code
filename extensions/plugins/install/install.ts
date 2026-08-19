/**
 * Plugin install/uninstall against the One Code plugin root.
 *
 * Install materializes the plugin's files into the versioned cache
 * (`./relative` sources are copied out of the marketplace clone after a
 * containment check — manifests are third-party content; git sources are
 * shallow-cloned), then records the `{scope: "user", installPath, version,
 * enabled: true}` entry in our installed_plugins.json. Never touches ~/.claude.
 *
 * Unsupported source kinds and features (npm/pip, commit-sha pinning,
 * dependencies) fail loudly with the reason named.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitClone, gitHeadSha } from "../marketplace/git.ts";
import type { MarketplaceEntry } from "../marketplace/types.ts";
import { addInstalledPlugin, installedEntry, removeInstalledPlugin } from "./registry.ts";
import { versionedCachePath, withinBase } from "./paths.ts";

export interface InstallResult {
	id: string;
	installPath: string;
	version: string;
	gitCommitSha?: string;
}

function manifestVersion(pluginDir: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8")) as {
			version?: unknown;
		};
		return typeof manifest.version === "string" ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

function copyIntoCache(src: string, dest: string): void {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(join(dest, ".."), { recursive: true });
	cpSync(src, dest, { recursive: true });
}

export async function installPlugin(
	root: string,
	marketplaceName: string,
	entry: MarketplaceEntry,
	contentRoot: string | undefined,
): Promise<InstallResult> {
	const id = `${entry.name}@${marketplaceName}`;
	const raw = entry.raw;
	if (raw.dependencies !== undefined) {
		throw new Error(`${id}: plugin dependencies are not supported yet — install the dependencies manually first`);
	}

	let sourceDir: string;
	let cleanup: string | undefined;
	let gitCommitSha: string | undefined;

	const source = entry.source;
	if (typeof source === "string") {
		if (!contentRoot) throw new Error(`${id}: the marketplace's content is not available locally (refresh it first)`);
		if (!withinBase(contentRoot, source)) {
			throw new Error(`${id}: source path "${source}" escapes the marketplace directory — refusing to install`);
		}
		sourceDir = resolve(contentRoot, source);
		if (!existsSync(sourceDir)) throw new Error(`${id}: source path "${source}" does not exist in the marketplace`);
	} else if (source.source === "github" || source.source === "url" || source.source === "git-subdir") {
		if (source.sha) {
			throw new Error(`${id}: commit-sha pinning is not supported yet — use a ref (branch/tag) instead`);
		}
		const url = source.source === "github" ? `https://github.com/${source.repo}.git` : source.url;
		const temp = mkdtempSync(join(tmpdir(), "one-code-plugin-"));
		cleanup = temp;
		const cloneDir = join(temp, "clone");
		await gitClone(url, cloneDir, {
			ref: source.ref,
			subdir: source.source === "git-subdir" ? source.path : undefined,
		});
		gitCommitSha = await gitHeadSha(cloneDir);
		sourceDir = source.source === "git-subdir" ? join(cloneDir, source.path) : cloneDir;
		if (source.source === "git-subdir" && !withinBase(cloneDir, source.path)) {
			rmSync(temp, { recursive: true, force: true });
			throw new Error(`${id}: git-subdir path "${source.path}" escapes the repository — refusing to install`);
		}
		if (!existsSync(sourceDir)) {
			rmSync(temp, { recursive: true, force: true });
			throw new Error(`${id}: "${source.source === "git-subdir" ? source.path : url}" has no content at the expected path`);
		}
	} else {
		throw new Error(`${id}: source kind "${(source as { source: string }).source}" is not supported`);
	}

	try {
		const version = entry.version ?? manifestVersion(sourceDir) ?? (gitCommitSha ? gitCommitSha.slice(0, 12) : "0.0.0");
		const installPath = versionedCachePath(root, marketplaceName, entry.name, version);
		copyIntoCache(sourceDir, installPath);
		const now = new Date().toISOString();
		addInstalledPlugin(root, id, {
			scope: "user",
			installPath,
			version,
			installedAt: now,
			lastUpdated: now,
			gitCommitSha,
			enabled: true,
		});
		return { id, installPath, version, gitCommitSha };
	} finally {
		if (cleanup) rmSync(cleanup, { recursive: true, force: true });
	}
}

/** Remove the registry entry and the cached files. Keeps `data/` (plugin-owned state). */
export function uninstallPlugin(root: string, id: string): void {
	const entry = installedEntry(root, id);
	removeInstalledPlugin(root, id);
	// Only delete what lives inside OUR cache — never an install path that
	// points elsewhere (hand-edited registries, claude-origin paths).
	const cacheDir = `${resolve(join(root, "cache"))}/`;
	if (entry?.installPath && resolve(entry.installPath).startsWith(cacheDir)) {
		rmSync(entry.installPath, { recursive: true, force: true });
	}
}

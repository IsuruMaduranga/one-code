/**
 * installed_plugins.json under the One Code plugin root (pure fs).
 *
 * Claude Code's v2 format, plus an `enabled` field on our entries (Claude Code
 * keeps enabled state in settings.json; in our own root the entry is the
 * natural home). Unknown keys round-trip untouched.
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../lib/atomic-write.ts";

export interface InstalledEntry {
	scope: "user";
	installPath: string;
	version?: string;
	installedAt?: string;
	lastUpdated?: string;
	gitCommitSha?: string;
	enabled?: boolean;
	[key: string]: unknown;
}

interface RegistryFile {
	version?: unknown;
	plugins?: Record<string, unknown>;
	[key: string]: unknown;
}

function registryPath(root: string): string {
	return join(root, "installed_plugins.json");
}

function readRegistry(root: string): RegistryFile {
	return readJsonFile<RegistryFile>(registryPath(root)) ?? {};
}

export function installedEntry(root: string, id: string): InstalledEntry | undefined {
	const entries = readRegistry(root).plugins?.[id];
	if (!Array.isArray(entries)) return undefined;
	return entries.find((e) => e && typeof e === "object") as InstalledEntry | undefined;
}

/** Add or replace the plugin's entry (one user-scope entry per id in our root). */
export function addInstalledPlugin(root: string, id: string, entry: InstalledEntry): void {
	const registry = readRegistry(root);
	writeJsonAtomic(registryPath(root), {
		...registry,
		version: 2,
		plugins: { ...(registry.plugins ?? {}), [id]: [entry] },
	});
}

export function removeInstalledPlugin(root: string, id: string): void {
	const registry = readRegistry(root);
	if (!registry.plugins || !(id in registry.plugins)) return;
	const { [id]: _removed, ...rest } = registry.plugins;
	writeJsonAtomic(registryPath(root), { ...registry, version: 2, plugins: rest });
}

/** Flip `enabled` on the plugin's entries, preserving everything else. */
export function setInstalledEnabled(root: string, id: string, enabled: boolean): boolean {
	const registry = readRegistry(root);
	const entries = registry.plugins?.[id];
	if (!Array.isArray(entries) || entries.length === 0) return false;
	const updated = entries.map((e) => (e && typeof e === "object" ? { ...(e as InstalledEntry), enabled } : e));
	writeJsonAtomic(registryPath(root), {
		...registry,
		version: 2,
		plugins: { ...(registry.plugins ?? {}), [id]: updated },
	});
	return true;
}

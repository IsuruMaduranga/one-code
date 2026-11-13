/**
 * Plugin roots for the discovery tests (plugins and its One Code sibling):
 * another tool's install root and the product's own under one temp folder,
 * with writers for an installed plugin and a root's registry.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { type DiscoverRoots, invalidatePluginsCache } from "../../../extensions/lib/plugins/plugins.ts";

export type PluginRoots = DiscoverRoots & { claudePluginsDir: string };

/**
 * Fresh roots for each test of the calling suite, with the discovery cache
 * cleared around it. The temp folder is `home`; the object is refilled before
 * each test, so read its fields inside the test.
 */
export function usePluginRoots(): PluginRoots {
	const roots = {} as PluginRoots;
	beforeEach(() => {
		const root = mkdtempSync(join(tmpdir(), "cc-plugins-merge-"));
		Object.assign(roots, {
			claudePluginsDir: join(root, ".claude", "plugins"),
			productRoot: join(root, "one-code", "plugins"),
			cwd: join(root, "project"),
			home: root,
		});
		mkdirSync(roots.cwd, { recursive: true });
		invalidatePluginsCache();
	});
	afterEach(() => {
		invalidatePluginsCache();
		rmSync(roots.home, { recursive: true, force: true });
	});
	return roots;
}

/** Installs plugin `name` under the root `base`, with one skill when asked, and returns its install path. */
export function writePlugin(base: string, name: string, extra?: { skill?: string }): string {
	const installPath = join(base, "cache", "market", name, "1.0.0");
	mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
	writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
	if (extra?.skill) {
		mkdirSync(join(installPath, "skills", extra.skill), { recursive: true });
		writeFileSync(join(installPath, "skills", extra.skill, "SKILL.md"), "---\nname: s\n---\nbody");
	}
	return installPath;
}

/** Writes the root `base`'s registry of installed plugins. */
export function writeRegistry(base: string, plugins: Record<string, unknown[]>): void {
	mkdirSync(base, { recursive: true });
	writeFileSync(join(base, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

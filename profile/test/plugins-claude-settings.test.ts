/**
 * Plugin discovery with One Code's source provider: a Claude Code plugin's
 * enabled state comes from Claude Code's settings files (user, then project
 * and local, later wins per key), and is on when they say nothing. The base's
 * plugins.test.ts covers discovery, overrides and the product's own root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiscoverRoots, discoverPlugins, invalidatePluginsCache } from "../../extensions/lib/plugins.ts";

describe("Claude Code plugins' enabled state", () => {
	let root: string;
	let roots: DiscoverRoots & { claudePluginsDir: string };

	const writePlugin = (base: string, name: string) => {
		const installPath = join(base, "cache", "market", name, "1.0.0");
		mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
		writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
		return installPath;
	};

	const writeRegistry = (base: string, plugins: Record<string, unknown[]>) => {
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cc-plugins-merge-"));
		roots = {
			claudePluginsDir: join(root, ".claude", "plugins"),
			oneCodeRoot: join(root, "one-code", "plugins"),
			cwd: join(root, "project"),
			home: root,
		};
		mkdirSync(roots.cwd, { recursive: true });
		invalidatePluginsCache();
	});
	afterEach(() => {
		invalidatePluginsCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("claude-origin: enabledPlugins from settings, default true when absent", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha");
		const b = writePlugin(roots.claudePluginsDir, "beta");
		writeRegistry(roots.claudePluginsDir, {
			"alpha@market": [{ scope: "user", installPath: a }],
			"beta@market": [{ scope: "user", installPath: b }],
		});
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "beta@market": false } }));

		const discovered = discoverPlugins(roots);
		expect(discovered.plugins.find((p) => p.id === "alpha@market")).toMatchObject({
			originRoot: "claude",
			enabled: true,
			overridden: false,
		});
		expect(discovered.plugins.find((p) => p.id === "beta@market")?.enabled).toBe(false);
		expect(discovered.enabledPlugins.map((p) => p.id)).toEqual(["alpha@market"]);
	});

	it("project/local settings win over user settings per key", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha");
		writeRegistry(roots.claudePluginsDir, { "alpha@market": [{ scope: "user", installPath: a }] });
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@market": false } }));
		mkdirSync(join(roots.cwd, ".claude"), { recursive: true });
		writeFileSync(join(roots.cwd, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "alpha@market": true } }));

		expect(discoverPlugins(roots).plugins[0]?.enabled).toBe(true);
	});
});

/**
 * Plugin discovery with One Code's source provider: a Claude Code plugin's
 * enabled state comes from Claude Code's settings files (user, then project
 * and local, later wins per key), and is on when they say nothing. The base's
 * plugins.test.ts covers discovery, overrides and the product's own root.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPlugins } from "../../extensions/lib/plugins/plugins.ts";
import { usePluginRoots, writePlugin, writeRegistry } from "../../test/unit/helpers/plugin-roots.ts";

describe("Claude Code plugins' enabled state", () => {
	const roots = usePluginRoots();

	it("claude-origin: enabledPlugins from settings, default true when absent", () => {
		const a = writePlugin(roots.claudePluginsDir, "alpha");
		const b = writePlugin(roots.claudePluginsDir, "beta");
		writeRegistry(roots.claudePluginsDir, {
			"alpha@market": [{ scope: "user", installPath: a }],
			"beta@market": [{ scope: "user", installPath: b }],
		});
		mkdirSync(join(roots.home, ".claude"), { recursive: true });
		writeFileSync(join(roots.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "beta@market": false } }));

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
		mkdirSync(join(roots.home, ".claude"), { recursive: true });
		writeFileSync(join(roots.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@market": false } }));
		mkdirSync(join(roots.cwd, ".claude"), { recursive: true });
		writeFileSync(join(roots.cwd, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "alpha@market": true } }));

		expect(discoverPlugins(roots).plugins[0]?.enabled).toBe(true);
	});
});

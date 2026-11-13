/**
 * /doctor's table of which settings file supplies each key
 * (commands/doctor/compat.ts SCOPE_KEYS), held to the loaders: each key is
 * written into one file of Claude Code's ladder alone, and the report may
 * count it as read from that file only when the loader takes it from there.
 * The managed file sits in a system folder a test cannot write, so its row
 * is checked against the loaders' own file lists.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { keysReadFrom } from "../../extensions/commands/doctor/compat.ts";
import { AUTO_MEMORY_KEY, savedAutoMemory } from "../../extensions/lib/context/auto-memory.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins/plugins.ts";
import { readEnabledPlugins, readSettingsEnv, settingsSources } from "../../extensions/lib/profile/settings-files.ts";
import type { SettingsFile } from "../../extensions/lib/profile/sources.ts";
import { autoModeSettingsPaths } from "../../extensions/lib/rules/auto-mode-config.ts";
import { listPermissionRules } from "../../extensions/lib/rules/settings.ts";
import { loadHookSettings, resetHookSettingsCache } from "../../extensions/safety/hooks/settings.ts";
import { readClaudeMcpjsonPolicy } from "../../extensions/tools/mcp/trust.ts";
import { tempHome } from "../../test/unit/helpers/temp-home.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	({ home, cwd } = tempHome("onecode-doctor-keys-"));
});

/** Each key: a value to write, and whether the loaders took it from the file it was written to. */
const PROBES: Record<string, { value: unknown; taken: (path: string) => boolean | Promise<boolean> }> = {
	permissions: { value: { allow: ["Bash(probe-rule)"] }, taken: () => listPermissionRules(cwd, home).some((rule) => JSON.stringify(rule).includes("probe-rule")) },
	hooks: { value: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "probe-hook" }] }] }, taken: () => JSON.stringify(loadHookSettings(cwd, home)).includes("probe-hook") },
	env: { value: { PROBE_VARIABLE: "1" }, taken: () => readSettingsEnv(home).PROBE_VARIABLE === "1" },
	enabledPlugins: { value: { "probe@market": true }, taken: () => readEnabledPlugins(cwd, home)["probe@market"] === true },
	autoMode: { value: { allow: ["probe"] }, taken: (path) => autoModeSettingsPaths(home).includes(path) },
	[AUTO_MEMORY_KEY]: { value: false, taken: () => savedAutoMemory(cwd, home) === false },
	enableAllProjectMcpServers: { value: true, taken: async () => (await readClaudeMcpjsonPolicy(cwd, home)).enableAll },
	enabledMcpjsonServers: { value: ["probe"], taken: async () => (await readClaudeMcpjsonPolicy(cwd, home)).enabled.has("probe") },
	disabledMcpjsonServers: { value: ["probe"], taken: async () => (await readClaudeMcpjsonPolicy(cwd, home)).disabled.has("probe") },
};

describe("/doctor's settings-key table", () => {
	it("counts a key as read from one of Claude Code's files exactly when the loader takes it from there", async () => {
		const drift: string[] = [];
		const files = settingsSources(cwd, home);
		const borrowed = files.filter((file) => file.owner === "borrowed" && file.scope !== "managed");
		expect(borrowed.map((file) => file.scope)).toEqual(["user", "project", "local"]);
		for (const file of borrowed) {
			const known = keysReadFrom(file, files);
			for (const [key, probe] of Object.entries(PROBES)) {
				mkdirSync(dirname(file.path), { recursive: true });
				writeFileSync(file.path, JSON.stringify({ [key]: probe.value }));
				resetHookSettingsCache();
				invalidatePluginsCache();
				const taken = await probe.taken(file.path);
				rmSync(file.path);
				if (taken !== known.has(key)) drift.push(`${file.scope} ${key}: the loader ${taken ? "reads" : "does not read"} it, the report says ${known.has(key) ? "used" : "not used"}`);
			}
		}
		expect(drift).toEqual([]);
	});

	it("counts for the managed file only what the loaders read from it", () => {
		const files = settingsSources(cwd, home);
		const managed = files.find((file): file is SettingsFile => file.scope === "managed");
		if (!managed) throw new Error("the ladder has no managed file");
		const known = keysReadFrom(managed, files);
		// readEnabledPlugins skips the managed file; readSettingsEnv and the MCP policy read the primary file alone.
		for (const key of ["enabledPlugins", "env", "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"]) expect(known.has(key), key).toBe(false);
		expect(known.has("autoMode")).toBe(autoModeSettingsPaths(home).includes(managed.path));
	});
});

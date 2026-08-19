import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonAtomic } from "../../extensions/lib/atomic-write.ts";
import { readEnabledPlugins } from "../../extensions/lib/claude-settings.ts";
import { readFavorites, toggleFavorite } from "../../extensions/lib/favorites.ts";
import { readOverrides, setOverride } from "../../extensions/lib/plugin-overrides.ts";
import { pluginRoot } from "../../extensions/lib/plugin-root.ts";
import { isSkillEnabled, readSkillOverrides, setSkillOverride, skillOverrideKey } from "../../extensions/lib/skill-overrides.ts";
import { estimateSkillTokens, scanSkills } from "../../extensions/lib/skill-scan.ts";
import { formatRecency, readUsage, recordUsage } from "../../extensions/lib/usage-tracker.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-stores-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("plugin root", () => {
	it("derives from the agent dir", () => {
		expect(pluginRoot("/home/u/.one-code/agent")).toBe("/home/u/.one-code/agent/plugins");
	});
});

describe("atomic-write", () => {
	it("writes via temp+rename leaving no temp files, and reads back", () => {
		const path = join(root, "nested", "file.json");
		writeJsonAtomic(path, { a: 1 });
		expect(readJsonFile(path)).toEqual({ a: 1 });
		expect(readdirSync(join(root, "nested")).filter((f) => f.includes(".tmp-"))).toEqual([]);
	});

	it("readJsonFile returns undefined for missing or malformed files", () => {
		expect(readJsonFile(join(root, "missing.json"))).toBeUndefined();
		writeFileSync(join(root, "bad.json"), "{ nope");
		expect(readJsonFile(join(root, "bad.json"))).toBeUndefined();
	});
});

describe("claude-settings readEnabledPlugins", () => {
	it("merges user → project → local, later wins; malformed files are ignored", () => {
		const home = join(root, "home");
		const cwd = join(root, "proj");
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": true } }));
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "b@m": false, "c@m": "yes" } }));
		writeFileSync(join(cwd, ".claude", "settings.local.json"), "{ broken");
		expect(readEnabledPlugins(cwd, home)).toEqual({ "a@m": true, "b@m": false });
	});
});

describe("override stores", () => {
	it("plugin overrides round-trip and drop non-boolean values", () => {
		setOverride(root, "a@m", false);
		setOverride(root, "b@m", true);
		expect(readOverrides(root)).toEqual({ "a@m": false, "b@m": true });
		const path = join(root, "overrides.json");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), junk: "x" }));
		expect(readOverrides(root)).toEqual({ "a@m": false, "b@m": true });
	});

	it("skill overrides key by scope and default to enabled", () => {
		const key = skillOverrideKey("plugin", "demo:helper");
		expect(key).toBe("plugin:demo:helper");
		expect(isSkillEnabled(readSkillOverrides(root), key)).toBe(true);
		setSkillOverride(root, key, false);
		expect(isSkillEnabled(readSkillOverrides(root), key)).toBe(false);
	});
});

describe("usage tracker", () => {
	it("counts invocations and formats recency", () => {
		const day1 = new Date("2026-08-01T10:00:00Z");
		recordUsage(root, "skill", "checkpoint", day1);
		recordUsage(root, "skill", "checkpoint", new Date("2026-08-16T10:00:00Z"));
		recordUsage(root, "command", "demo:commit", day1);
		const usage = readUsage(root);
		expect(usage["skill:checkpoint"]).toMatchObject({ count: 2 });
		expect(formatRecency(usage["skill:checkpoint"], new Date("2026-08-19T10:00:00Z"))).toBe("2× 3d");
		expect(formatRecency(usage["command:demo:commit"], new Date("2026-08-01T12:00:00Z"))).toBe("1× today");
		expect(formatRecency(undefined)).toBe("never used");
	});
});

describe("favorites", () => {
	it("toggles per kind and reports the new state", () => {
		expect(toggleFavorite(root, "plugin", "a@m")).toBe(true);
		expect(toggleFavorite(root, "skill", "user:helper")).toBe(true);
		expect(readFavorites(root)).toEqual({ plugins: ["a@m"], skills: ["user:helper"] });
		expect(toggleFavorite(root, "plugin", "a@m")).toBe(false);
		expect(readFavorites(root).plugins).toEqual([]);
	});
});

describe("skill scan", () => {
	it("scans project/user/agent dirs and merges plugin skills", () => {
		const cwd = join(root, "proj");
		const home = join(root, "home");
		const agentDir = join(root, "agent");
		for (const [base, name] of [
			[join(cwd, ".claude", "skills"), "proj-skill"],
			[join(home, ".claude", "skills"), "user-skill"],
			[join(agentDir, "skills"), "agent-skill"],
		] as const) {
			mkdirSync(join(base, name), { recursive: true });
			writeFileSync(join(base, name, "SKILL.md"), "---\nname: x\n---\nbody text here");
		}
		const skills = scanSkills(cwd, home, agentDir, [{ name: "demo:helper", plugin: "demo", path: "/p/SKILL.md" }]);
		expect(skills.map((s) => `${s.scope}:${s.name}`).sort()).toEqual([
			"plugin:demo:helper",
			"project:proj-skill",
			"user:agent-skill",
			"user:user-skill",
		]);
		expect(estimateSkillTokens(skills.find((s) => s.name === "proj-skill")!.path)).toBeGreaterThan(0);
		expect(estimateSkillTokens("/nope/SKILL.md")).toBe(0);
	});
});

describe("write-boundary invariant", () => {
	it("no plugin-feature module writes under a .claude path", () => {
		// The isolation contract: ~/.claude is read-only. Statically scan every
		// module of this feature that performs writes for a ".claude" literal.
		const writeModules = [
			"extensions/lib/atomic-write.ts",
			"extensions/lib/plugin-overrides.ts",
			"extensions/lib/skill-overrides.ts",
			"extensions/lib/usage-tracker.ts",
			"extensions/lib/favorites.ts",
			"extensions/plugins/marketplace/registry.ts",
			"extensions/plugins/marketplace/git.ts",
			"extensions/plugins/marketplace/sync.ts",
			"extensions/plugins/install/paths.ts",
			"extensions/plugins/install/registry.ts",
			"extensions/plugins/install/install.ts",
			"extensions/plugins/counts.ts",
		];
		const stripComments = (source: string) =>
			source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		for (const module of writeModules) {
			const source = stripComments(readFileSync(join(__dirname, "..", "..", module), "utf-8"));
			// `.claude-plugin/` is a directory inside marketplace clones (fine);
			// the forbidden reference is the user's ~/.claude state dir.
			expect(/\.claude(?!-plugin)/.test(source), `${module} must not reference .claude in code`).toBe(false);
		}
		// And the one module that DOES read .claude settings must not write at all.
		const settings = readFileSync(join(__dirname, "..", "..", "extensions/lib/claude-settings.ts"), "utf-8");
		for (const writer of ["writeFileSync", "writeJsonAtomic", "renameSync", "appendFileSync"]) {
			expect(settings.includes(writer), `claude-settings.ts must stay read-only (${writer})`).toBe(false);
		}
	});
});

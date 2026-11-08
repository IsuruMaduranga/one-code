/**
 * The plugin and skill stores with One Code's source provider: Claude Code's
 * enabled-plugin map merged across its settings files, and its skill folders
 * (`~/.claude/skills`, `<cwd>/.claude/skills`) scanned beside the base's. The
 * base's plugin-stores.test.ts covers the stores on the base's own folders.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEnabledPlugins } from "../../extensions/lib/claude-settings.ts";
import { estimateSkillTokens, scanSkills } from "../../extensions/lib/skill-scan.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-stores-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

describe("skill scan of Claude Code's folders", () => {
	it("loads a name once and a linked file once, as pi does", () => {
		const cwd = join(root, "proj");
		const home = join(root, "home");
		const agentDir = join(root, "agent");
		const bundled = join(root, "bundled-skills");
		const make = (base: string, name: string) => {
			mkdirSync(join(base, name), { recursive: true });
			writeFileSync(join(base, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
		};
		make(join(home, ".agents", "skills"), "simplify");
		make(bundled, "simplify");
		make(bundled, "loop");
		// No declared name: the folder names it, so only the real path ties the link to it.
		mkdirSync(join(home, ".claude", "skills", "shared"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "shared", "SKILL.md"), "---\ndescription: d\n---\nbody");
		mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
		symlinkSync(join(home, ".claude", "skills", "shared"), join(cwd, ".agents", "skills", "linked"), "junction");
		const skills = scanSkills(cwd, home, agentDir, [], bundled);
		expect(skills.map((s) => s.name)).toEqual(["loop", "shared", "simplify"]);
		// The user's simplify wins over the bundled one, as pi's first-wins load does.
		expect(skills.find((s) => s.name === "simplify")?.path).toBe(join(home, ".agents", "skills", "simplify", "SKILL.md"));
	});

	it("scans project/user/agent dirs and merges plugin skills", () => {
		const cwd = join(root, "proj");
		const home = join(root, "home");
		const agentDir = join(root, "agent");
		const bundled = join(root, "bundled-skills");
		for (const [base, name] of [
			[join(cwd, ".claude", "skills"), "proj-skill"],
			[join(cwd, ".agents", "skills"), "proj-agents-skill"],
			[join(home, ".claude", "skills"), "user-skill"],
			[join(home, ".agents", "skills"), "user-agents-skill"],
			[join(agentDir, "skills"), "agent-skill"],
			[bundled, "bundled-skill"],
		] as const) {
			mkdirSync(join(base, name), { recursive: true });
			writeFileSync(join(base, name, "SKILL.md"), `---\nname: ${name}\n---\nbody text here`);
		}
		const skills = scanSkills(cwd, home, agentDir, [{ name: "demo:helper", plugin: "demo", path: "/p/SKILL.md" }], bundled);
		expect(skills.map((s) => `${s.scope}:${s.name}`).sort()).toEqual([
			"plugin:demo:helper",
			"project:bundled-skill",
			"project:proj-agents-skill",
			"project:proj-skill",
			"user:agent-skill",
			"user:user-agents-skill",
			"user:user-skill",
		]);
		// Without the bundled root (the /plugins tab's call) the catalog is not scanned.
		expect(scanSkills(cwd, home, agentDir, []).some((s) => s.name === "bundled-skill")).toBe(false);
		expect(estimateSkillTokens(skills.find((s) => s.name === "proj-skill")!.path)).toBeGreaterThan(0);
		expect(estimateSkillTokens("/nope/SKILL.md")).toBe(0);
	});
});

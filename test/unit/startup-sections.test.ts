import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectStartupSections,
	contextFileNames,
	quietStartupEnabled,
	skillNames,
	themeNames,
	workflowNames,
} from "../../extensions/branding/startup.ts";

const tmp: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(os.tmpdir(), "one-code-startup-"));
	tmp.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("contextFileNames", () => {
	it("collects CLAUDE.md and AGENTS.md from cwd up to the git root", () => {
		const root = scratch();
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "CLAUDE.md"), "root");
		writeFileSync(join(root, "sub", "AGENTS.md"), "sub");
		expect(contextFileNames(join(root, "sub"))).toEqual(["AGENTS.md", join("..", "CLAUDE.md")]);
	});

	it("does not walk above cwd outside a git repo", () => {
		const root = scratch();
		writeFileSync(join(root, "CLAUDE.md"), "outside");
		mkdirSync(join(root, "inner"));
		expect(contextFileNames(join(root, "inner"))).toEqual([]);
	});
});

describe("skillNames", () => {
	it("lists SKILL.md directories from project and user dirs, deduped and sorted", () => {
		const cwd = scratch();
		const home = scratch();
		for (const [base, name] of [
			[join(cwd, ".claude", "skills"), "beta"],
			[join(home, ".claude", "skills"), "alpha"],
			[join(home, ".claude", "skills"), "beta"],
		] as const) {
			mkdirSync(join(base, name), { recursive: true });
			writeFileSync(join(base, name, "SKILL.md"), "s");
		}
		mkdirSync(join(home, ".claude", "skills", "not-a-skill"), { recursive: true });
		expect(skillNames(cwd, home, join(home, ".pi", "agent"))).toEqual(["alpha", "beta"]);
	});
});

describe("themeNames", () => {
	it("lists bundled theme json names", () => {
		const dir = scratch();
		writeFileSync(join(dir, "one-code.json"), "{}");
		writeFileSync(join(dir, "one-code-light.json"), "{}");
		writeFileSync(join(dir, "README.md"), "not a theme");
		expect(themeNames(dir)).toEqual(["one-code", "one-code-light"]);
	});
});

describe("workflowNames", () => {
	it("lists .js/.mjs workflow scripts from project and user dirs, deduped and sorted", () => {
		const cwd = scratch();
		const home = scratch();
		mkdirSync(join(cwd, ".claude", "workflows"), { recursive: true });
		mkdirSync(join(home, ".claude", "workflows"), { recursive: true });
		writeFileSync(join(cwd, ".claude", "workflows", "review.js"), "");
		writeFileSync(join(home, ".claude", "workflows", "audit.mjs"), "");
		writeFileSync(join(home, ".claude", "workflows", "review.js"), "");
		writeFileSync(join(home, ".claude", "workflows", "notes.txt"), "");
		expect(workflowNames(cwd, home)).toEqual(["audit", "review"]);
	});
});

describe("quietStartupEnabled", () => {
	it("is true only when the setting is exactly true", () => {
		const dir = scratch();
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ quietStartup: true }));
		expect(quietStartupEnabled(path)).toBe(true);
		writeFileSync(path, JSON.stringify({ quietStartup: false }));
		expect(quietStartupEnabled(path)).toBe(false);
		expect(quietStartupEnabled(join(dir, "missing.json"))).toBe(false);
	});
});

describe("collectStartupSections", () => {
	it("drops empty sections", () => {
		const cwd = scratch();
		const home = scratch();
		const themes = scratch();
		writeFileSync(join(themes, "one-code.json"), "{}");
		expect(collectStartupSections(cwd, home, themes, join(home, ".pi", "agent"))).toEqual([{ label: "themes", items: ["one-code"] }]);
	});
});

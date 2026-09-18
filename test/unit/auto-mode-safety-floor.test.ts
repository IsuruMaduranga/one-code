import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafetyControlTarget, safetyControlWrite } from "../../extensions/auto-mode/safety-floor.ts";
import { oneCodeProjectSettingsPath } from "../../extensions/lib/one-code-settings.ts";
import { claudeJsonPath, forwardSlashes, toPosixPath } from "../../extensions/lib/paths.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cc-floor-home-"));
	cwd = mkdtempSync(join(tmpdir(), "cc-floor-cwd-"));
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "settings.json"), "{}");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const check = (toolName: string, input: Record<string, unknown>) =>
	safetyControlWrite({ toolName, input, cwd, home });

/** A path as it is spelled inside a bash command line: forward slashes (a backslash is an escape there). */
const sh = forwardSlashes;

describe("safetyControlWrite: writing tools", () => {
	it("floors a write to the user settings file, however it is spelled", () => {
		expect(check("write", { path: join(home, ".claude", "settings.json") })).toContain("permission rules");
		expect(check("edit", { file_path: join(home, ".claude", "settings.json") })).toBeDefined();
		expect(check("write", { path: "~/.claude/settings.json" })).toBeDefined();
	});

	it("floors project-scope settings files, in this checkout or another", () => {
		expect(check("write", { path: ".claude/settings.json" })).toBeDefined();
		expect(check("write", { path: ".claude/settings.local.json" })).toBeDefined();
		expect(check("write", { path: join(tmpdir(), "other-checkout", ".claude", "settings.json") })).toBeDefined();
	});

	it("floors ~/.claude.json, which also carries permission state", () => {
		expect(check("write", { path: join(home, ".claude.json") })).toBeDefined();
	});

	it("stays out of the way of routine writes, including elsewhere under ~/.claude", () => {
		// ~/.claude also holds memory and skills the agent writes routinely; a
		// floor that fires on routine work teaches the user to approve blind.
		expect(check("write", { path: join(cwd, "src", "index.ts") })).toBeUndefined();
		expect(check("write", { path: join(home, ".claude", "projects", "p", "memory", "note.md") })).toBeUndefined();
		expect(check("write", { path: join(home, ".claude", "skills", "deploy", "SKILL.md") })).toBeUndefined();
		expect(check("read", { path: join(home, ".claude", "settings.json") })).toBeUndefined();
	});

	it("resolves a symlink to a settings file rather than trusting the literal path", () => {
		symlinkSync(join(home, ".claude", "settings.json"), join(cwd, "innocent.json"));
		expect(check("write", { path: join(cwd, "innocent.json") })).toBeDefined();
	});

	it("resolves a symlinked parent directory, even for a file that does not exist yet", () => {
		symlinkSync(join(home, ".claude"), join(cwd, "cfg"));
		expect(check("write", { path: join(cwd, "cfg", "settings.json") })).toBeDefined();
	});
});

describe("safetyControlWrite: shell commands", () => {
	it("floors a redirect into the settings file", () => {
		expect(check("bash", { command: `echo '{}' > ${sh(join(home, ".claude", "settings.json"))}` })).toBeDefined();
		expect(check("bash", { command: "echo '{}' > ~/.claude/settings.json" })).toBeDefined();
	});

	it("floors file-writing commands aimed at settings files", () => {
		expect(check("bash", { command: `cp /tmp/mine.json ${sh(join(cwd, ".claude", "settings.local.json"))}` })).toBeDefined();
	});

	it("does not floor reads of the same files", () => {
		expect(check("bash", { command: "cat ~/.claude/settings.json" })).toBeUndefined();
	});

	it("leaves ordinary shell work alone", () => {
		expect(check("bash", { command: "npm test" })).toBeUndefined();
		expect(check("bash", { command: `echo hi > ${join(cwd, "out.txt")}` })).toBeUndefined();
	});
});

describe("safetyControlWrite: relocated config dirs (distribution L2)", () => {
	const savedClaude = process.env.CLAUDE_CONFIG_DIR;
	const savedState = process.env.ONECODE_STATE_DIR;
	afterEach(() => {
		if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedClaude;
		if (savedState === undefined) delete process.env.ONECODE_STATE_DIR;
		else process.env.ONECODE_STATE_DIR = savedState;
	});

	it("floors the relocated .claude.json when CLAUDE_CONFIG_DIR is set", () => {
		const cfg = join(cwd, "cc-work");
		mkdirSync(cfg, { recursive: true });
		process.env.CLAUDE_CONFIG_DIR = cfg;
		expect(check("write", { path: claudeJsonPath(home) })).toBeDefined();
	});

	it("floors the per-repo One Code settings file for the current cwd", () => {
		const perRepo = oneCodeProjectSettingsPath(cwd, home);
		expect(check("write", { path: perRepo })).toBeDefined();
	});

	it("floors the per-repo One Code settings file under a relocated ONECODE_STATE_DIR", () => {
		const state = join(cwd, "state");
		process.env.ONECODE_STATE_DIR = state;
		const perRepo = oneCodeProjectSettingsPath(cwd, home);
		expect(perRepo.startsWith(state)).toBe(true);
		expect(check("write", { path: perRepo })).toBeDefined();
	});
});

describe("isSafetyControlTarget", () => {
	it("matches any .claude settings tail, wherever it lives", () => {
		expect(isSafetyControlTarget("/somewhere/else/.claude/settings.json", home)).toBe(true);
		expect(isSafetyControlTarget("/somewhere/else/.claude/settings.local.json", home)).toBe(true);
	});

	it("matches One Code's own settings files — global and per-repo — wherever they live", () => {
		// Both carry permissions.allow that bypasses the classifier, so a write to
		// either must hit the deterministic floor, not the auto-mode classifier.
		expect(isSafetyControlTarget("/home/u/.onecode/settings.json", home)).toBe(true);
		expect(isSafetyControlTarget("/home/u/.onecode/projects/-home-u-repo/settings.json", home)).toBe(true);
	});

	it("does not match lookalikes", () => {
		expect(isSafetyControlTarget("/repo/.claude/settings.json.bak", home)).toBe(false);
		expect(isSafetyControlTarget("/repo/claude/settings.json", home)).toBe(false);
		expect(isSafetyControlTarget("/repo/.claude/worktrees/x/settings.json", home)).toBe(false);
		// One Code's plan files and other .onecode contents are not gate controls.
		expect(isSafetyControlTarget("/home/u/.onecode/plans/p.md", home)).toBe(false);
		expect(isSafetyControlTarget("/home/u/.onecode/settings.json.bak", home)).toBe(false);
	});
});

describe.skipIf(process.platform !== "win32")("safetyControlWrite: Git Bash path spellings on Windows", () => {
	it("floors a settings write spelled /c/…", () => {
		expect(check("bash", { command: `echo '{}' > ${toPosixPath(join(home, ".claude", "settings.json"))}` })).toBeDefined();
	});

	it("floors a settings write spelled /tmp/… (this home is under %TEMP%)", () => {
		const underTemp = forwardSlashes(relative(tmpdir(), join(home, ".claude", "settings.json")));
		expect(check("bash", { command: `echo '{}' > /tmp/${underTemp}` })).toBeDefined();
	});
});

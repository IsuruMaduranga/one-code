import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoMemoryEnabled, autoMemoryFromEnv, readAutoMemory, resetAutoMemoryForTest, savedAutoMemory } from "../../extensions/lib/auto-memory.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { readMemoryIndex } from "../../extensions/lib/memory-index.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { buildMemoryEntries } from "../../extensions/memory/entries.ts";
import { stubHome } from "./helpers/home.ts";

let root: string;
let home: string;
let cwd: string;
const write = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "auto-memory-"));
	home = join(root, "home");
	cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	stubHome(home);
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
	vi.stubEnv("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "");
	resetConfigModeForTest("claude-compatible");
});
afterEach(() => {
	vi.unstubAllEnvs();
	resetConfigModeForTest();
	resetAutoMemoryForTest();
	rmSync(root, { recursive: true, force: true });
});

describe("autoMemoryFromEnv", () => {
	it("turns auto-memory off on a truthy value and forces it on on a falsy one", () => {
		expect(autoMemoryFromEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })).toBe(false);
		expect(autoMemoryFromEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "true" })).toBe(false);
		expect(autoMemoryFromEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" })).toBe(true);
		expect(autoMemoryFromEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "false" })).toBe(true);
		expect(autoMemoryFromEnv({})).toBeUndefined();
		expect(autoMemoryFromEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "maybe" })).toBeUndefined();
	});
});

describe("savedAutoMemory", () => {
	it("defaults to on", () => {
		expect(savedAutoMemory(cwd, home)).toBe(true);
	});

	it("reads One Code's user settings, which the /memory toggle writes", () => {
		write(join(home, ".onecode", "settings.json"), { autoMemoryEnabled: false });
		expect(savedAutoMemory(cwd, home)).toBe(false);
	});

	it("lets a project file outrank the user file, as Claude Code's ladder does", () => {
		write(join(home, ".onecode", "settings.json"), { autoMemoryEnabled: false });
		write(join(cwd, ".claude", "settings.json"), { autoMemoryEnabled: true });
		expect(savedAutoMemory(cwd, home)).toBe(true);
	});

	it("reads no Claude Code file in independent mode", () => {
		resetConfigModeForTest("independent");
		write(join(home, ".claude", "settings.json"), { autoMemoryEnabled: false });
		expect(savedAutoMemory(cwd, home)).toBe(true);
	});

	it("gives the env variable the last word", () => {
		write(join(home, ".onecode", "settings.json"), { autoMemoryEnabled: false });
		expect(readAutoMemory(cwd, home, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" })).toBe(true);
	});
});

describe("auto-memory off", () => {
	it("is pinned for the process until reset", () => {
		resetAutoMemoryForTest(false);
		write(join(home, ".onecode", "settings.json"), { autoMemoryEnabled: true });
		expect(autoMemoryEnabled(cwd)).toBe(false);
	});

	it("loads no MEMORY.md index", () => {
		const index = join(projectMemoryDir(cwd), "MEMORY.md");
		mkdirSync(dirname(index), { recursive: true });
		writeFileSync(index, "- [note](note.md)\n");
		resetAutoMemoryForTest(true);
		expect(readMemoryIndex(cwd)?.content).toContain("note");
		resetAutoMemoryForTest(false);
		expect(readMemoryIndex(cwd)).toBeNull();
	});

	it("drops the folder row from the /memory entries", () => {
		const entries = buildMemoryEntries({ cwd, home, homeClaudeDir: join(home, ".claude"), homeOneCodeDir: join(home, ".onecode"), memoryDir: undefined });
		expect(entries.some((entry) => entry.kind === "folder")).toBe(false);
	});
});

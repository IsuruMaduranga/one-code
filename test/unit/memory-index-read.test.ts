import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_INSTRUCTION_BYTES } from "../../extensions/lib/claude-rules.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { readMemoryIndex } from "../../extensions/lib/memory-index.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { stubHome } from "./helpers/home.ts";

let root: string;
let cwd: string;
let index: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-index-read-"));
	stubHome(root);
	vi.stubEnv("ONECODE_STATE_DIR", join(root, ".onecode"));
	resetConfigModeForTest("independent");
	cwd = join(root, "project");
	mkdirSync(cwd);
	index = join(projectMemoryDir(cwd), "MEMORY.md");
	mkdirSync(dirname(index), { recursive: true });
});
afterEach(() => {
	vi.unstubAllEnvs();
	resetConfigModeForTest();
	rmSync(root, { recursive: true, force: true });
});

describe("memory index raw file limit", () => {
	it("loads a regular file at exactly Claude Code's 4 MiB limit", () => {
		writeFileSync(index, `entry\n${" ".repeat(MAX_INSTRUCTION_BYTES - 6)}`);
		expect(readMemoryIndex(cwd)?.content.trim()).toBe("entry");
	});

	it("skips an index above the raw byte limit instead of loading its prefix", () => {
		writeFileSync(index, `entry\n${" ".repeat(MAX_INSTRUCTION_BYTES - 5)}`);
		expect(readMemoryIndex(cwd)).toBeNull();
	});
});

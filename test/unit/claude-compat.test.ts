import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeResourcePaths } from "../../extensions/claude-compat/index.ts";

describe("claudeResourcePaths", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cc-compat-home-"));
		cwd = mkdtempSync(join(tmpdir(), "cc-compat-cwd-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns only directories that exist", () => {
		expect(claudeResourcePaths(cwd, home)).toEqual({ skillPaths: [], promptPaths: [] });
	});

	it("discovers .claude and .agents skill dirs, user and project scope", () => {
		// ~/.agents/skills is the cross-tool Agent Skills directory, which
		// Claude Code also reads — a skill installed there must work here too.
		for (const dir of [
			join(home, ".claude", "skills"),
			join(home, ".agents", "skills"),
			join(cwd, ".claude", "skills"),
			join(cwd, ".agents", "skills"),
			join(home, ".claude", "commands"),
		]) {
			mkdirSync(dir, { recursive: true });
		}
		expect(claudeResourcePaths(cwd, home)).toEqual({
			skillPaths: [
				join(home, ".claude", "skills"),
				join(home, ".agents", "skills"),
				join(cwd, ".claude", "skills"),
				join(cwd, ".agents", "skills"),
			],
			promptPaths: [join(home, ".claude", "commands")],
		});
	});
});

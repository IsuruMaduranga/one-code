/**
 * With One Code's source provider on, the skill and command folders include
 * Claude Code's: `.claude/skills` ahead of `.agents/skills` in each scope, and
 * `~/.claude/commands`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeResourcePaths } from "../../extensions/claude-compat/index.ts";

describe("claudeResourcePaths with Claude Code's folders", () => {
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

	it("discovers .claude and .agents skill dirs, user and project scope", () => {
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

	it("keeps the bundled skills dir after a user's .claude skills", () => {
		const bundled = join(cwd, "bundled-skills");
		mkdirSync(join(home, ".claude", "skills"), { recursive: true });
		mkdirSync(bundled, { recursive: true });
		expect(claudeResourcePaths(cwd, home, bundled).skillPaths).toEqual([join(home, ".claude", "skills"), bundled]);
	});
});

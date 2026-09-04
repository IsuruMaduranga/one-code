import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitRoot, findProjectRoot, linkedWorktreeMainRoot } from "../../extensions/lib/git.ts";

/**
 * Laid out by hand rather than with `git worktree add`: what matters is the
 * on-disk shape git leaves behind (a `.git` FILE pointing at
 * `<main>/.git/worktrees/<name>`), and the test must not depend on git.
 */
describe("findProjectRoot (SUBAGENT-REVIEW L3)", () => {
	const dirs: string[] = [];
	const tmp = () => {
		const dir = mkdtempSync(join(tmpdir(), "git-root-"));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("a linked worktree resolves to its main checkout; findGitRoot still stops at the worktree", () => {
		const main = tmp();
		mkdirSync(join(main, ".git", "worktrees", "wt-1"), { recursive: true });
		const worktree = join(tmp(), "tree");
		mkdirSync(join(worktree, "src"), { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt-1")}\n`);

		expect(findGitRoot(join(worktree, "src"))).toBe(worktree);
		expect(findProjectRoot(join(worktree, "src"))).toBe(main);
		expect(linkedWorktreeMainRoot(worktree)).toBe(main);
	});

	it("accepts a relative gitdir pointer", () => {
		const base = tmp();
		mkdirSync(join(base, "main", ".git", "worktrees", "feature"), { recursive: true });
		mkdirSync(join(base, "feature"));
		writeFileSync(join(base, "feature", ".git"), "gitdir: ../main/.git/worktrees/feature\n");
		expect(findProjectRoot(join(base, "feature"))).toBe(join(base, "main"));
	});

	it("a main checkout is its own project root", () => {
		const main = tmp();
		mkdirSync(join(main, ".git", "objects"), { recursive: true });
		mkdirSync(join(main, "a", "b"), { recursive: true });
		expect(findProjectRoot(join(main, "a", "b"))).toBe(main);
		expect(linkedWorktreeMainRoot(main)).toBeUndefined();
	});

	it("a submodule keeps its own root (gitdir points into .git/modules)", () => {
		const superRoot = tmp();
		mkdirSync(join(superRoot, ".git", "modules", "lib"), { recursive: true });
		mkdirSync(join(superRoot, "lib"));
		writeFileSync(join(superRoot, "lib", ".git"), `gitdir: ${join(superRoot, ".git", "modules", "lib")}\n`);
		expect(findProjectRoot(join(superRoot, "lib"))).toBe(join(superRoot, "lib"));
	});

	it("outside any repository both resolve to undefined", () => {
		const loose = tmp();
		expect(findGitRoot(loose)).toBeUndefined();
		expect(findProjectRoot(loose)).toBeUndefined();
	});
});

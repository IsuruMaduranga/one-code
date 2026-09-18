/** Shared git helpers — pure functions only (safe to import across extensions). */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Whether the checkout at `cwd` has no uncommitted or untracked changes, or
 * undefined when git could not say (not a repo, git missing). One short
 * `git status --porcelain`, asynchronous so the tool_call hook it runs from
 * does not stall the event loop; used for the classifier transcript's
 * ground-truth line after a `git status` call (permissions/index.ts).
 */
export function gitStatusClean(cwd: string): Promise<boolean | undefined> {
	return new Promise((resolvePromise) => {
		execFile("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 5_000, windowsHide: true }, (error, stdout) => {
			resolvePromise(error ? undefined : stdout.trim().length === 0);
		});
	});
}

/**
 * The nearest checkout root at or above `startDir`: the directory holding a
 * `.git` entry (a directory for a main checkout, a file for a linked worktree
 * or a submodule). This is the bound for walking up a checkout (context files,
 * banner listing); for the repository a directory *belongs to*, which linked
 * worktrees share with their main checkout, use `findProjectRoot`.
 */
export function findGitRoot(startDir: string): string | undefined {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The repository `startDir` belongs to — the checkout root, except that a
 * linked worktree (`git worktree add`, including a subagent's isolation
 * worktree in a tmpdir) resolves to its MAIN checkout, so every worktree of one
 * repository shares one project identity (auto-memory dir, per-repo settings,
 * project trust). A submodule keeps its own root. Pure filesystem: the linked
 * worktree's `.git` is a file reading `gitdir: <main>/.git/worktrees/<name>`.
 */
export function findProjectRoot(startDir: string): string | undefined {
	const root = findGitRoot(startDir);
	if (!root) return undefined;
	return linkedWorktreeMainRoot(root) ?? root;
}

/** For a linked worktree root, the main checkout it belongs to; undefined otherwise. Exported for tests. */
export function linkedWorktreeMainRoot(root: string): string | undefined {
	const dotGit = join(root, ".git");
	let gitdir: string;
	try {
		if (!statSync(dotGit).isFile()) return undefined;
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
		if (!match) return undefined;
		gitdir = match[1];
	} catch {
		return undefined;
	}
	const absolute = isAbsolute(gitdir) ? gitdir : resolve(root, gitdir);
	// <main>/.git/worktrees/<name> → <main>. A submodule's gitdir points into
	// <super>/.git/modules/<name> and is left alone.
	const worktrees = dirname(absolute);
	const mainDotGit = dirname(worktrees);
	if (basename(worktrees) !== "worktrees" || basename(mainDotGit) !== ".git") return undefined;
	return dirname(mainDotGit);
}

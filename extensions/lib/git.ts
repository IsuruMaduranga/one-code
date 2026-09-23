/** Shared git helpers — pure functions only (safe to import across extensions). */

/**
 * Global options for every git command the harness runs on its own (startup
 * git status, recoverability, consent checks, worktree bookkeeping). git
 * honours the checkout's own `.git/config`, and `core.fsmonitor` there names a
 * program that `status` and other index reads run — so a directory whose
 * `.git` came from an archive or a copied tree would run it the moment One
 * Code starts in it, before any prompt (SECURITY-REVIEW-2026-09-23 M5).
 * `--no-optional-locks` stops `status` rewriting the index, which would run the
 * checkout's `post-index-change` hook. The model's own git commands are judged
 * by the permission gate instead (auto-mode/git-checkout-programs.ts).
 */
export const HARNESS_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * `git status` output for `cwd` with the given arguments, or undefined when
 * git could not say (not a repo, git missing, timeout). Asynchronous so the
 * tool_call hook it runs from does not stall the event loop; used for the
 * classifier transcript's gitStatus line (auto-mode/git-status-meta.ts).
 */
export function gitStatusOutput(cwd: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		execFile("git", [...HARNESS_GIT_CONFIG, ...args], { cwd, encoding: "utf8", timeout: 5_000, windowsHide: true }, (error, stdout) => {
			resolvePromise(error ? undefined : stdout);
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

/**
 * The git dir a checkout root's `.git` FILE points at (a linked worktree or a
 * submodule: `gitdir: <path>`), absolute; undefined when `.git` is a directory,
 * missing, or unreadable.
 */
export function gitdirFileTarget(root: string): string | undefined {
	const dotGit = join(root, ".git");
	try {
		if (!statSync(dotGit).isFile()) return undefined;
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
		if (!match) return undefined;
		return isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
	} catch {
		return undefined;
	}
}

/** For a linked worktree root, the main checkout it belongs to; undefined otherwise. Exported for tests. */
export function linkedWorktreeMainRoot(root: string): string | undefined {
	const absolute = gitdirFileTarget(root);
	if (!absolute) return undefined;
	// <main>/.git/worktrees/<name> → <main>. A submodule's gitdir points into
	// <super>/.git/modules/<name> and is left alone.
	const worktrees = dirname(absolute);
	const mainDotGit = dirname(worktrees);
	if (basename(worktrees) !== "worktrees" || basename(mainDotGit) !== ".git") return undefined;
	return dirname(mainDotGit);
}

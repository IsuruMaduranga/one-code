/**
 * Git worktree isolation for subagent runs.
 *
 * Claude Code's `isolation: "worktree"` gives an agent its own checkout so
 * parallel agents editing files cannot collide, and removes it again if the agent
 * changed nothing.
 */

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
	path: string;
	branch: string;
}

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await run("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		return (await git(["rev-parse", "--is-inside-work-tree"], cwd)) === "true";
	} catch {
		return false;
	}
}

/** Creates a detached worktree at the current HEAD. */
export async function createWorktree(cwd: string, label: string): Promise<Worktree> {
	const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "agent";
	const dir = mkdtempSync(join(tmpdir(), `cc-wt-${safeLabel}-`));
	const path = join(dir, "tree");
	const branch = `cc-subagent/${safeLabel}-${Date.now().toString(36)}`;
	await git(["worktree", "add", "-b", branch, path, "HEAD"], cwd);
	return { path, branch };
}

export async function worktreeHasChanges(worktree: Worktree): Promise<boolean> {
	try {
		const status = await git(["status", "--porcelain"], worktree.path);
		return status.length > 0;
	} catch {
		// If status fails, assume there is something worth keeping.
		return true;
	}
}

/**
 * Removes the worktree when the agent left it untouched; otherwise keeps it so
 * the caller can inspect or merge the work, and returns false.
 */
export async function cleanupWorktree(cwd: string, worktree: Worktree): Promise<boolean> {
	if (await worktreeHasChanges(worktree)) return false;
	try {
		await git(["worktree", "remove", "--force", worktree.path], cwd);
		await git(["branch", "-D", worktree.branch], cwd);
	} catch {
		// Leave it behind rather than failing the run.
		return false;
	}
	return true;
}

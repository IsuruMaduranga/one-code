/**
 * Git worktree isolation for subagent runs.
 *
 * Claude Code's `isolation: "worktree"` gives an agent its own checkout so
 * parallel agents editing files cannot collide, and removes it again if the agent
 * changed nothing: no uncommitted change and no commit past the HEAD it was
 * created at. A worktree whose agent committed its work is kept like one with
 * uncommitted edits, so the commits stay reachable on its branch.
 */

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { registerWorktreeIsolation, releaseWorktreeIsolation } from "../lib/worktree-isolation.ts";
import { findProjectRoot, HARNESS_GIT_CONFIG, HARNESS_GIT_NO_HOOKS } from "../lib/git.ts";
import { checkoutGitRunsProgram } from "../auto-mode/git-checkout-programs.ts";

const run = promisify(execFile);

export interface Worktree {
	path: string;
	branch: string;
	/** The commit the worktree was created at; commits past it are the agent's work. */
	baseCommit: string;
}

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await run("git", [...HARNESS_GIT_CONFIG, ...HARNESS_GIT_NO_HOOKS, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		return (await git(["rev-parse", "--is-inside-work-tree"], cwd)) === "true";
	} catch {
		return false;
	}
}

/** Creates a worktree on a new throwaway branch at the current HEAD. */
export async function createWorktree(cwd: string, label: string): Promise<Worktree> {
	const program = checkoutGitRunsProgram(cwd, homedir(), []);
	if (program) {
		throw new Error(`Cannot create an isolation worktree: ${program}. Create the worktree with an explicitly approved git worktree add command, then start a session there without automatic isolation.`);
	}
	const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "agent";
	const dir = mkdtempSync(join(tmpdir(), `cc-wt-${safeLabel}-`));
	const path = join(dir, "tree");
	const branch = `cc-subagent/${basename(dir).slice("cc-wt-".length)}`;
	await git(["worktree", "add", "-b", branch, path, "HEAD"], cwd);
	// Register for the child permission gate's git-isolation guard. The shared
	// checkout's ROOT, not cwd — the spawn may run from a subdirectory — and the
	// MAIN checkout's root when it runs from a linked worktree (an entered
	// `enter_worktree` session), so git into either is refused.
	let sharedRoot = cwd;
	try {
		// git prints `C:/…` on Windows; resolve gives the native form.
		const top = resolve(await git(["rev-parse", "--show-toplevel"], cwd));
		sharedRoot = findProjectRoot(top) ?? top;
	} catch {
		// Keep cwd as the best available anchor.
	}
	registerWorktreeIsolation(path, sharedRoot);
	let baseCommit: string;
	try {
		baseCommit = await git(["rev-parse", "HEAD"], path);
	} catch (error) {
		// Without the base, cleanup could not tell the agent's commits apart;
		// remove the fresh worktree now rather than run in one we cannot judge.
		await git(["worktree", "remove", "--force", path], cwd).catch(() => undefined);
		await git(["branch", "-D", branch], cwd).catch(() => undefined);
		releaseWorktreeIsolation(path);
		throw error;
	}
	return { path, branch, baseCommit };
}

/**
 * Whether the worktree holds work: uncommitted changes, or commits reachable
 * from its HEAD or its branch that the base commit does not contain (an agent
 * that commits leaves a clean status). Any git failure counts as work.
 */
export async function worktreeHasChanges(worktree: Worktree): Promise<boolean> {
	try {
		const status = await git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], worktree.path);
		if (status.length > 0) return true;
		const ahead = await git(["rev-list", "--count", "HEAD", `refs/heads/${worktree.branch}`, `^${worktree.baseCommit}`], worktree.path);
		return ahead !== "0";
	} catch {
		// If git fails, assume there is something worth keeping.
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
	} catch {
		// Leave it behind rather than failing the run.
		return false;
	}
	try {
		// `-d`, not `-D`: git itself refuses to drop a branch with unmerged work,
		// a second check behind worktreeHasChanges. A refused delete leaves a
		// branch at the base commit, which holds none of the agent's work.
		await git(["branch", "-d", worktree.branch], cwd);
	} catch {
		// The worktree is gone; the branch stays for the user to inspect.
	}
	// Release only when the worktree is actually gone — a kept worktree can
	// still host a resumed session (SendMessage), which must stay guarded.
	releaseWorktreeIsolation(worktree.path);
	return true;
}

/** The note a result carries for a worktree kept because it holds the agent's work. */
export function keptWorktreeNote(path: string, branch: string | undefined): string {
	return `(Changes or commits left in worktree ${path}${branch ? ` on branch ${branch}` : ""} — review or merge them.)`;
}

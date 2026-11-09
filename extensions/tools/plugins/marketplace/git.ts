/**
 * Non-interactive git operations for marketplace/plugin fetching.
 *
 * Every call is prompt-proof (GIT_TERMINAL_PROMPT=0, empty GIT_ASKPASS,
 * BatchMode SSH with strict host checking) and time-bounded. Clones land in a
 * temp sibling and are renamed into place on success, so a failed or timed-out
 * clone never leaves a partial directory behind.
 */

import { execFile } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const GIT_TIMEOUT_MS = 120_000;

const GIT_BASE_ARGS = ["-c", 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'];

function gitEnv(): NodeJS.ProcessEnv {
	return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
}

async function git(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
	try {
		const { stdout } = await run("git", [...GIT_BASE_ARGS, ...args], {
			cwd,
			env: gitEnv(),
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (error) {
		const detail = error as { stderr?: string; message?: string; code?: string };
		if (detail.code === "ENOENT") throw new Error("git is not installed (or not on PATH)");
		const stderr = (detail.stderr ?? "").trim().split("\n").slice(-3).join(" ");
		throw new Error(stderr || detail.message || "git failed");
	}
}

export interface GitCloneOptions {
	ref?: string;
	/** Sparse checkout of just this subdirectory (partial clone). */
	subdir?: string;
	timeoutMs?: number;
}

/**
 * URLs and refs come from third-party marketplace manifests; one starting
 * with "-" would be parsed by git as an option (e.g. --upload-pack=…), not a
 * repository — classic argument injection even though execFile is shell-safe.
 */
function assertSafeGitValue(value: string, what: string): void {
	if (value.startsWith("-")) throw new Error(`refusing ${what} starting with "-": ${value}`);
}

export async function gitClone(url: string, dest: string, options: GitCloneOptions = {}): Promise<void> {
	assertSafeGitValue(url, "a git URL");
	if (options.ref) assertSafeGitValue(options.ref, "a git ref");
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
	const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
	mkdirSync(dirname(dest), { recursive: true });
	try {
		const args = ["clone", "--depth", "1"];
		if (options.subdir) args.push("--filter=tree:0", "--no-checkout");
		else args.push("--recurse-submodules", "--shallow-submodules");
		if (options.ref) args.push("--branch", options.ref);
		args.push("--", url, tmp);
		await git(args, undefined, timeoutMs);
		if (options.subdir) {
			await git(["sparse-checkout", "set", "--cone", "--", options.subdir], tmp, timeoutMs);
			await git(["checkout", "HEAD"], tmp, timeoutMs);
		}
		rmSync(dest, { recursive: true, force: true });
		renameSync(tmp, dest);
	} catch (error) {
		rmSync(tmp, { recursive: true, force: true });
		throw error;
	}
}

/** In-place update; the caller falls back to a fresh gitClone when this throws. */
export async function gitUpdate(dest: string, options: { ref?: string; timeoutMs?: number } = {}): Promise<void> {
	if (options.ref) assertSafeGitValue(options.ref, "a git ref");
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
	if (options.ref) {
		await git(["fetch", "--depth", "1", "origin", options.ref], dest, timeoutMs);
		await git(["checkout", options.ref], dest, timeoutMs);
		await git(["reset", "--hard", "FETCH_HEAD"], dest, timeoutMs);
	} else {
		await git(["fetch", "--depth", "1", "origin", "HEAD"], dest, timeoutMs);
		await git(["reset", "--hard", "FETCH_HEAD"], dest, timeoutMs);
	}
}

export async function gitHeadSha(dest: string): Promise<string | undefined> {
	try {
		return await git(["rev-parse", "HEAD"], dest, 10_000);
	} catch {
		return undefined;
	}
}

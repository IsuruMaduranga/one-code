/**
 * Claude Code's `gitStatus:` block — appended to the very end of the system
 * prompt in a git repo, identical across model tiers, and a one-time snapshot:
 * CC states it is "the git status at the start of the conversation" and "will not
 * update during the conversation", so it is computed once per session and frozen.
 *
 * Format and commands reverse-engineered from real CC captures
 * (git-cc-sonnet.json / git-cc-haiku.json): `git branch --show-current`, the main
 * branch from `origin/HEAD` (falling back to a local main/master), `git config
 * user.name`, `git status --porcelain`, and `git log -5 --format='%h %s'`. Both
 * the status and the log are whole-output `.trim()`ed — which is why a leading
 * `??`/` M` porcelain line renders flush-left in the capture.
 *
 * Bounded the way Claude Code bounds it: the status is clipped at 2,000
 * characters with Claude Code's note, a clean tree reads `(clean)`, an empty
 * user name drops the `Git user:` line, and a `git status` that fails or hangs
 * past the timeout drops the whole block, as Claude Code does on a failed
 * snapshot.
 *
 * The module is pure apart from `defaultRunner`; `collectGitStatus` takes an
 * injectable runner so the git commands can be faked in unit tests.
 */

import { execFileSync } from "node:child_process";
import { HARNESS_GIT_CONFIG } from "../lib/git.ts";

export interface GitSnapshot {
	branch: string;
	mainBranch: string;
	user: string;
	/** `git status --porcelain`, trimmed. */
	status: string;
	/** `git log -5 --format='%h %s'`, trimmed. */
	commits: string;
}

const HEADER =
	"gitStatus: This is the git status at the start of the conversation. " +
	"Note that this status is a snapshot in time, and will not update during the conversation.";

/** Claude Code's limit on the status inside the block, in characters. */
export const GIT_STATUS_MAX_CHARS = 2000;

/** Each git command's time limit: a hung `git status` (a network filesystem) must not block the first turn. */
export const GIT_TIMEOUT_MS = 10_000;

/**
 * The status as the block carries it: cut at 2,000 characters with Claude
 * Code's note, which names the shell tool the model has.
 */
export function clipGitStatus(status: string, shellTool = "bash"): string {
	if (status.length <= GIT_STATUS_MAX_CHARS) return status;
	return `${status.substring(0, GIT_STATUS_MAX_CHARS)}\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${shellTool})`;
}

/** Assemble CC's block from a snapshot. Pure; byte-exact against the captures. */
export function formatGitStatus(s: GitSnapshot): string {
	return [
		HEADER,
		"",
		`Current branch: ${s.branch}`,
		"",
		`Main branch (you will usually use this for PRs): ${s.mainBranch}`,
		"",
		...(s.user ? [`Git user: ${s.user}`, ""] : []),
		"Status:",
		s.status || "(clean)",
		"",
		"Recent commits:",
		s.commits,
	].join("\n");
}

/** Runs one git command in `cwd`, returning trimmed stdout or null on any failure. */
export type GitRunner = (args: string[]) => string | null;

function defaultRunner(cwd: string): GitRunner {
	return (args) => {
		try {
			return execFileSync("git", [...HARNESS_GIT_CONFIG, ...args], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
				// A status over the 1 MiB default would fail instead of being clipped.
				maxBuffer: 64 * 1024 * 1024,
			}).trim();
		} catch {
			return null;
		}
	};
}

/** The main branch: `origin/HEAD` if set, else a local `main`/`master`, else the current branch. */
function resolveMainBranch(run: GitRunner, branch: string): string {
	const originHead = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead) return originHead.replace(/^origin\//, "");
	for (const candidate of ["main", "master"]) {
		if (run(["rev-parse", "--verify", "--quiet", candidate])) return candidate;
	}
	return branch;
}

/**
 * CC's `gitStatus:` block for `cwd`, or null when `cwd` is not inside a git work
 * tree or `git status` fails (or times out): an empty status would claim a
 * clean tree. Other command failures degrade to empty fields rather than
 * dropping the whole block. `shellTool` is the tool the clip note tells the
 * model to run `git status` with.
 */
export function collectGitStatus(cwd: string, runner?: GitRunner, shellTool = "bash"): string | null {
	const run = runner ?? defaultRunner(cwd);
	if (run(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

	const branch = run(["branch", "--show-current"]) ?? "";
	const mainBranch = resolveMainBranch(run, branch);
	const user = run(["config", "user.name"]) ?? "";
	const status = run(["status", "--porcelain"]);
	if (status === null) return null;
	return formatGitStatus({
		branch,
		mainBranch,
		user,
		status: clipGitStatus(status, shellTool),
		commits: run(["log", "-5", "--format=%h %s"]) ?? "",
	});
}

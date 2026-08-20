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
 * The module is pure apart from `defaultRunner`; `collectGitStatus` takes an
 * injectable runner so the git commands can be faked in unit tests.
 */

import { execFileSync } from "node:child_process";

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

/** Assemble CC's block from a snapshot. Pure; byte-exact against the captures. */
export function formatGitStatus(s: GitSnapshot): string {
	return [
		HEADER,
		"",
		`Current branch: ${s.branch}`,
		"",
		`Main branch (you will usually use this for PRs): ${s.mainBranch}`,
		"",
		`Git user: ${s.user}`,
		"",
		"Status:",
		s.status,
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
			return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
 * tree. Individual command failures degrade to empty fields rather than dropping
 * the whole block, matching CC's per-field resilience.
 */
export function collectGitStatus(cwd: string, runner?: GitRunner): string | null {
	const run = runner ?? defaultRunner(cwd);
	if (run(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

	const branch = run(["branch", "--show-current"]) ?? "";
	return formatGitStatus({
		branch,
		mainBranch: resolveMainBranch(run, branch),
		user: run(["config", "user.name"]) ?? "",
		status: run(["status", "--porcelain"]) ?? "",
		commits: run(["log", "-5", "--format=%h %s"]) ?? "",
	});
}

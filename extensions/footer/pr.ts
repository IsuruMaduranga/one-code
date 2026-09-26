/**
 * Open-PR lookup for the footer, mirroring Claude Code's PR indicator. Uses the
 * GitHub CLI (`gh`) so it inherits the user's existing auth; when `gh` is absent
 * or the branch has no open PR it resolves to `undefined` and the footer simply
 * omits the field — same graceful degrade as pi's git-branch watcher.
 *
 * `gh pr list --head <branch>`, not `gh pr view <branch>`: the latter only finds
 * a PR whose head lives in the base repo, so it misses the common case of a PR
 * opened from a fork (`isCrossRepository`), even though `list` on the base repo
 * knows about it. `--state open` keeps a merged/closed PR for the same branch
 * name from showing. The footer repeats the lookup once a minute while the
 * session is in use (`nextPrPollDelay`), so a PR merged, closed or opened
 * mid-session shows within a minute.
 *
 * The exec lives here but the parse is split out so it unit-tests without a
 * subprocess.
 */

import { execFile } from "node:child_process";

/**
 * Pull the PR number out of `gh pr list --json number` output — a JSON array of
 * PRs (possibly empty). The first open PR for the branch wins.
 */
export function parsePrNumber(stdout: string): number | undefined {
	try {
		const data = JSON.parse(stdout) as Array<{ number?: unknown }>;
		if (!Array.isArray(data)) return undefined;
		for (const pr of data) {
			if (pr && typeof pr.number === "number" && Number.isFinite(pr.number)) return pr.number;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

const LOOKUP_TIMEOUT_MS = 4000;

/** A lookup's outcome: the open PR, if any, and whether `gh` is not installed at all. */
export interface PrLookup {
	pr: number | undefined;
	ghMissing: boolean;
}

/**
 * Resolve the open PR number for `branch` in `cwd`. Never rejects: any failure
 * (no gh, no PR, detached HEAD, timeout) has `pr` undefined, and a `gh` that
 * is not on PATH says so, so the footer stops polling for it.
 */
export function fetchPrNumber(cwd: string, branch: string): Promise<PrLookup> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			["pr", "list", "--head", branch, "--state", "open", "--json", "number"],
			{ cwd, timeout: LOOKUP_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout) => {
				const ghMissing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
				resolve({ pr: error ? undefined : parsePrNumber(stdout), ghMissing });
			},
		);
	});
}

/** Claude Code's PR status cadence (its `usePrStatus`): one lookup a minute while the session is in use. */
export const PR_POLL_INTERVAL_MS = 60_000;
/** Polling stops after this long without user input, and resumes on the next input. */
export const PR_IDLE_STOP_MS = 60 * 60_000;
/** A lookup slower than this turns polling off for the session (branch changes still look up). */
export const PR_SLOW_LOOKUP_MS = 4_000;

/**
 * When the next PR lookup is due, relative to the last one: never sooner than
 * PR_POLL_INTERVAL_MS after it, so a turn boundary asking for a refresh does
 * not spawn `gh` more than once a minute. Undefined when polling should stop:
 * turned off by a slow lookup, or no input for PR_IDLE_STOP_MS.
 */
export function nextPrPollDelay(state: { lastLookupAt: number; lastInputAt: number; disabled: boolean }, now: number): number | undefined {
	if (state.disabled) return undefined;
	if (now - state.lastInputAt >= PR_IDLE_STOP_MS) return undefined;
	return Math.max(0, state.lastLookupAt + PR_POLL_INTERVAL_MS - now);
}

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
 * name from showing.
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

/**
 * Resolve the open PR number for `branch` in `cwd`, or `undefined`. Never
 * rejects: any failure (no gh, no PR, detached HEAD, timeout) is `undefined`.
 */
export function fetchPrNumber(cwd: string, branch: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			["pr", "list", "--head", branch, "--state", "open", "--json", "number"],
			{ cwd, timeout: LOOKUP_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout) => {
				resolve(error ? undefined : parsePrNumber(stdout));
			},
		);
	});
}

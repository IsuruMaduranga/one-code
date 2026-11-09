/**
 * A stand-in for git, for the git status tests (git-status and One Code's
 * git-status-wording).
 */
import type { GitRunner } from "../../../extensions/lib/context/git-status.ts";

/** A fake git runner keyed by the space-joined argv; any other call fails. */
export function fakeRunner(map: Record<string, string>): GitRunner {
	return (args) => {
		const key = args.join(" ");
		return key in map ? map[key] : null;
	};
}

/** git's answers in a work tree on `feature/x`, user Ada, one changed file and one commit; no main branch is found. */
export const IN_WORK_TREE: Record<string, string> = {
	"rev-parse --is-inside-work-tree": "true",
	"branch --show-current": "feature/x",
	"config user.name": "Ada",
	"status --porcelain": "M a.ts",
	"log -5 --format=%h %s": "abc First",
};

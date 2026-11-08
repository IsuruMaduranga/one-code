/**
 * One Code's wording of the worktree guards' refusals (its profile's
 * `worktreeGuard` group), over every refusal the bash and PowerShell guards
 * produce. Both shells' guards return the same refusal data, so one table
 * covers them. Which command yields which refusal is tested, on any profile,
 * in test/unit/worktree-guards.test.ts and
 * test/unit/worktree-powershell-guards.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { GitTargetProblem, StashRisk } from "../../extensions/worktree/text.ts";
import { worktreeGuard } from "../text/worktree/guard.ts";

const WT = "/repo/.claude/worktrees/wt1";

/** Each git-target problem, with the phrases its refusal must carry. */
const GIT_TARGET: { [K in GitTargetProblem["kind"]]: { problem: Extract<GitTargetProblem, { kind: K }>; says: string[] } } = {
	unlisted: { problem: { kind: "unlisted" }, says: ["worktrees could not be listed", "without -C, --git-dir or --work-tree"] },
	tooComplex: { problem: { kind: "tooComplex" }, says: ["too complex to verify"] },
	stdinFed: { problem: { kind: "stdinFed" }, says: ["stdin at runtime (xargs/parallel)", `Run the equivalent from ${WT} without the redirect.`] },
	cdInLoop: { problem: { kind: "cdInLoop" }, says: ["inside a loop"] },
	cdInPipeline: { problem: { kind: "cdInPipeline" }, says: ["last command of a pipeline"] },
	wrapper: { problem: { kind: "wrapper", wrapper: "sudo" }, says: ["runs git through sudo"] },
	findExec: { problem: { kind: "findExec" }, says: ["find -exec"] },
	precedingCd: { problem: { kind: "precedingCd" }, says: ["unverifiable"] },
	runtimeEnv: { problem: { kind: "runtimeEnv", name: "GIT_DIR" }, says: ["`GIT_DIR`", "decided at runtime"] },
	runtimeFlag: { problem: { kind: "runtimeFlag", flag: "-C" }, says: ["`git -C` computes its repository target at runtime", "cannot be verified"] },
	sharedTarget: {
		problem: { kind: "sharedTarget", target: "/repo/.claude/worktrees/wt2" },
		says: ["targets /repo/.claude/worktrees/wt2", "the shared checkout or another worktree of the same repository", `against ${WT}`],
	},
	unfollowedQuoting: { problem: { kind: "unfollowedQuoting" }, says: ["quoting could not be followed"] },
	besideSyntax: { problem: { kind: "besideSyntax", syntax: "the call (&) or dot-source operator" }, says: ["runs git next to the call (&) or dot-source operator"] },
	repositoryVariable: { problem: { kind: "repositoryVariable" }, says: ["GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR"] },
	configEnv: { problem: { kind: "configEnv" }, says: ["`git --config-env`", "at runtime"] },
};

/** Each stash risk, with the phrase naming its hazard. */
const STASH: Record<StashRisk, string> = {
	untagged: "untagged",
	pop: "another session's entry",
	clear: "every session's stashes",
	drop: "stash@{0}",
	branch: "stash@{0}",
};

describe("One Code's worktree guard refusals", () => {
	it.each(Object.values(GIT_TARGET))("words a $problem.kind git target", ({ problem, says }) => {
		const text = worktreeGuard.refusal({ kind: "gitTarget", worktreePath: WT, problem });
		// Every git-target refusal names the worktree and the rule it enforces.
		expect(text).toContain(`This session is isolated in the worktree ${WT}`);
		expect(text).toContain("must target its own worktree");
		for (const phrase of says) expect(text).toContain(phrase);
	});

	it.each(Object.entries(STASH) as [StashRisk, string][])("words the %s stash risk with the full recipe", (risk, hazard) => {
		const text = worktreeGuard.refusal({ kind: "stash", risk, command: "git stash pop" });
		expect(text).toContain("Blocked: `git stash pop`");
		expect(text).toContain("stash stack is shared");
		expect(text).toContain(hazard);
		expect(text).toContain('git stash push -u -m "<unique-tag>"');
		expect(text).toContain("git stash apply <sha>");
	});
});

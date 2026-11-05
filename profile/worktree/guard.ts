/**
 * One Code's worktree guard refusals (the profile's `text.worktreeGuard`): git
 * that may reach another checkout of the repository, a stash form that
 * collides with parallel sessions, and an isolated subagent's write into the
 * shared checkout. Each names the fix.
 */

import type { GitTargetProblem, StashRisk, WorktreeGuardRefusal, WorktreeGuardText } from "../../extensions/worktree/text.ts";

/** Why the target cannot be verified, and the fix, for a worktree at `wt`. */
function gitTarget(problem: GitTargetProblem, wt: string): [string, string] {
	const plainCommands = `Break it into plain, separate git commands with literal paths and run them from ${wt}.`;
	const literalPaths = `Use literal paths inside ${wt} instead.`;
	const plainStatement = `Run git as its own plain statement, with literal paths inside ${wt} (no script blocks, call operators or nested shells).`;
	switch (problem.kind) {
		case "unlisted":
			return [
				"the repository's worktrees could not be listed, so the repository this git command targets cannot be verified",
				`Retry; if it keeps failing, run git from ${wt} without -C, --git-dir or --work-tree.`,
			];
		case "tooComplex":
			return ["this command is too complex to verify that its git operations stay inside the worktree", plainCommands];
		// Claude Code's exact refusal for stdin-fed git (one static string for
		// both mechanisms): keep it byte-identical to the capture.
		case "stdinFed":
			return [
				"this command feeds git its arguments from stdin at runtime (xargs/parallel), so the repository it targets cannot be verified",
				`Run the equivalent from ${wt} without the redirect.`,
			];
		case "cdInLoop":
			return ["this command changes directory inside a loop, so the repository its git commands target cannot be verified", plainCommands];
		case "cdInPipeline":
			return [
				"this command changes directory in the last command of a pipeline, which can run in the current shell, so the repository its git commands target cannot be verified",
				plainCommands,
			];
		case "wrapper":
			return [`this command runs git through ${problem.wrapper}, which can change the repository it targets`, `Run git directly, with literal paths inside ${wt}.`];
		case "findExec":
			return [
				"this command assembles git invocations at runtime (find -exec), so the repositories they target cannot be verified",
				"Run the git commands directly, with explicit literal paths, instead of assembling them at runtime.",
			];
		case "precedingCd":
			return ["a preceding directory change makes the repository this git command targets unverifiable", literalPaths];
		case "runtimeEnv":
			return [`\`${problem.name}\` points git at a repository that is decided at runtime, so it cannot be verified`, `Drop the ${problem.name} setting and run git from ${wt}.`];
		case "runtimeFlag":
			return [`\`git ${problem.flag}\` computes its repository target at runtime, so it cannot be verified`, literalPaths];
		case "sharedTarget":
			return [`this git command targets ${problem.target}, which is the shared checkout or another worktree of the same repository`, `Run the equivalent against ${wt}.`];
		case "unfollowedQuoting":
			return ["this command's quoting could not be followed, so the repository its git commands target cannot be verified", plainStatement];
		case "besideSyntax":
			return [`this command runs git next to ${problem.syntax}, so the repository it targets cannot be verified`, plainStatement];
		case "repositoryVariable":
			return ["this command sets GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR, which can point git at another repository", `Drop the variable and run git from ${wt}.`];
		case "configEnv":
			return ["`git --config-env` reads its configuration at runtime, so the repository it targets cannot be verified", literalPaths];
	}
}

const STASH_HAZARD: Record<StashRisk, string> = {
	untagged: "an untagged entry cannot be reliably re-found once other sessions push their own",
	pop: "`pop` resolves stash indexes at apply time, so it can grab or destroy another session's entry",
	clear: "`clear` deletes every session's stashes, not just yours",
	drop: "a ref-less `drop` deletes whatever is currently stash@{0}, which may be another session's entry",
	branch: "without a stash ref, `branch` pops whatever is currently stash@{0}, which may be another session's entry",
};

function refusal(r: WorktreeGuardRefusal): string {
	switch (r.kind) {
		case "gitTarget": {
			const [problem, fix] = gitTarget(r.problem, r.worktreePath);
			return (
				`This session is isolated in the worktree ${r.worktreePath}, but ${problem}. ` +
				`Refusing to run it — a worktree-isolated session's git operations must target its own worktree. ${fix}`
			);
		}
		case "stash":
			return (
				`Blocked: \`${r.command}\` — the git stash stack is shared between the main checkout and every worktree of this repository, and parallel sessions may push or pop entries concurrently; ${STASH_HAZARD[r.risk]}. ` +
				"Prefer a temporary WIP commit on this worktree's branch to set work aside. If you must stash: " +
				'`git stash push -u -m "<unique-tag>"`, capture your entry\'s SHA with `git stash list --format=\'%H %gs\'`, ' +
				"restore with `git stash apply <sha>` (not pop), and drop your entry only after re-finding it by tag."
			);
		case "sharedCheckoutWrite": {
			const what = r.inCommand ? `this command writes to ${r.target}, which` : r.target;
			return (
				`This agent is isolated in the worktree ${r.worktreePath}, but ${what} is in the shared checkout ${r.sharedRoot}. ` +
				`Refusing the write — an isolated agent's changes belong in its own worktree. Write the corresponding path there instead: ${r.mapped}`
			);
		}
	}
}

export const worktreeGuard: WorktreeGuardText = { refusal };

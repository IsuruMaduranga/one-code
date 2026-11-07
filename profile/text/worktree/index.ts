/**
 * One Code's worktree-tool text (the profile's `text.worktree`): Claude Code's
 * EnterWorktree/ExitWorktree descriptions (descriptions.ts), the results, and
 * the session reminders.
 */

import type { EnterWorktreeFailure, RemoveBlocker, WorktreeNameProblem, WorktreeSessionView, WorktreeText } from "../../../extensions/worktree/text.ts";
import { enterWorktreeDescription, ENTER_WORKTREE_PARAMS, EXIT_WORKTREE_DESCRIPTION, EXIT_WORKTREE_PARAMS } from "./descriptions.ts";
import { checkoutProgram } from "./guard.ts";

/**
 * The worktree git-isolation guard, said when the session enters: before it,
 * GPT-6 Sol and Astra both ran a read-only `git -C <main checkout> status`
 * and met the refusal with no warning (2026-10-04 self-test).
 */
const ISOLATION_NOTE = "Git commands aimed at the main checkout or another worktree of this repository are refused until you exit.";

const onBranch = (branch: string | undefined) => (branch ? ` (branch ${branch})` : "");

const NAME_PROBLEM: Record<WorktreeNameProblem, string> = {
	length: "name must be 1-64 characters",
	characters: "each /-separated segment may contain only letters, digits, dots, underscores, and dashes",
	dotSegment: "segments may not be . or ..",
};

function enterFailed(failure: EnterWorktreeFailure): string {
	switch (failure.kind) {
		case "nameAndPath":
			return "Pass either `name` or `path`, not both.";
		case "emptyPath":
			return "`path` was empty — pass an existing worktree path from `git worktree list`, or omit `path` to create a new worktree.";
		case "notARepository":
			return "enter_worktree needs a git repository; this directory is not one.";
		case "notListed":
			return `${failure.path} is not a worktree of this repository. Known worktrees:\n${failure.known.join("\n")}`;
		case "listedMissing":
			return `Worktree ${failure.path} no longer exists. Choose an existing worktree from \`git worktree list\`.`;
		case "alreadyActive":
			return `Already in a worktree session (${failure.path}). exit_worktree first, or switch with \`path\` to another worktree.`;
		case "invalidName":
			return `Invalid worktree name "${failure.name}": ${NAME_PROBLEM[failure.problem]}`;
		case "checkoutRunsProgram":
			return `Could not create worktree safely: ${checkoutProgram(failure.program)}. Create it with a permission-reviewed \`git worktree add\` command, then enter it with \`path\`.`;
		case "exists":
			return `Worktree ${failure.path} already exists — pass it as \`path\` to switch into it.`;
		case "createFailed":
			return `Could not create worktree: ${failure.osMessage}`;
	}
}

function blocker(b: RemoveBlocker): string {
	switch (b.kind) {
		case "uncommitted":
			return `Uncommitted files:\n${b.files}`;
		case "commitsAhead":
			return `${b.count} commit(s) on HEAD or ${b.branch} not on the original branch.`;
		case "baseUnknown":
			return "Could not verify commits without the original branch and base commit.";
		case "statusUnknown":
			return "Could not verify the worktree is clean.";
	}
}

const left = (s: WorktreeSessionView) => `Left worktree session; back in ${s.originalCwd}.`;

export const worktree: WorktreeText = {
	descriptions: { enter_worktree: enterWorktreeDescription, exit_worktree: EXIT_WORKTREE_DESCRIPTION },
	params: { enter: ENTER_WORKTREE_PARAMS, exit: EXIT_WORKTREE_PARAMS },
	searchKeywords: {
		enter_worktree: ["worktree", "isolate", "branch", "checkout"],
		exit_worktree: ["worktree", "leave", "return", "cleanup"],
	},
	reminder: (s) =>
		`Worktree session active: you are working in the git worktree at ${s.path}${onBranch(s.branch)}, not in ${s.originalCwd}. ` +
		"Relative paths and bash commands already run there. Use exit_worktree to leave when the user asks.",
	missingOnRestore: (s) => `${left(s)} The worktree at ${s.path} no longer exists.`,
	activeMissing: (s) =>
		`The active worktree at ${s.path} no longer exists. Use exit_worktree with action: "keep" to return to ${s.originalCwd}, or enter_worktree with path to switch to an existing worktree. No tool has run in the original checkout.`,
	enter: {
		failed: enterFailed,
		switched: ({ session: s, branchError }) =>
			`Switched into existing worktree ${s.path}${onBranch(s.branch)}.${branchError === undefined ? "" : ` Its branch could not be read (${branchError}).`} All work now happens there; exit_worktree returns to ${s.originalCwd}. ${ISOLATION_NOTE}`,
		created: ({ session: s, baseCommit }) =>
			`Created worktree ${s.path} on branch ${s.branch} (from HEAD ${baseCommit.slice(0, 8)}). All commands and relative paths now run there; exit_worktree returns to ${s.originalCwd}. ${ISOLATION_NOTE}`,
	},
	exit: {
		noSession: "No worktree session is active; nothing to exit.",
		kept: ({ session: s, exists }) =>
			`${left(s)} ` +
			(exists
				? `The worktree remains at ${s.path}${onBranch(s.branch)} — re-enter it with enter_worktree (path: "${s.path}").`
				: `The worktree at ${s.path} no longer exists. No branch was removed.`),
		notCreatedHere: (s) => `This worktree (${s.path}) was not created by enter_worktree in this session — exit with action: "keep" and remove it manually if intended.`,
		removeRefused: ({ session: s, blockers }) =>
			`Refusing to remove ${s.path}:\n\n${blockers.map(blocker).join("\n\n")}\n\nConfirm with the user, then re-invoke with discard_changes: true — or exit with action: "keep".`,
		removeFailed: (osMessage) => `Could not remove the worktree: ${osMessage}`,
		branchDeleteFailed: ({ session: s, branch, osMessage }) =>
			`Removed worktree ${s.path}; back in ${s.originalCwd}, but could not delete branch ${branch}: ${osMessage}. Inspect the branch before removing it manually.`,
		removed: (s) => `Removed worktree ${s.path}${s.branch ? ` and branch ${s.branch}` : ""}; back in ${s.originalCwd}.`,
	},
};

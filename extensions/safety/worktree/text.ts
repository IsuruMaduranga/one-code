/**
 * What the worktree tools need from a profile (types only). The extension
 * decides what happened; the profile words it (working-docs/features/profiles/).
 * The shell guards' refusals are the base's own
 * (lib/rules/worktree-guard-text.ts): subagent worktree isolation uses them
 * too.
 */
import type { CheckoutProgram } from "../../lib/shell/git-checkout-programs.ts";

/** The worktree session as the result and reminder texts name it. */
export interface WorktreeSessionView {
	path: string;
	branch?: string;
	originalCwd: string;
}

/** Why a worktree name was rejected (rewrite.ts validateWorktreeName). */
export type WorktreeNameProblem = "length" | "characters" | "dotSegment";

/** Why enter_worktree did nothing. `osMessage` is git's or the system's own text, passed through. */
export type EnterWorktreeFailure =
	| { kind: "nameAndPath" }
	| { kind: "emptyPath" }
	| { kind: "notARepository" }
	| { kind: "notListed"; path: string; known: readonly string[] }
	| { kind: "listedMissing"; path: string }
	| { kind: "alreadyActive"; path: string }
	| { kind: "invalidName"; name: string; problem: WorktreeNameProblem }
	/** `program`: what a checkout would run (lib/shell/git-checkout-programs.ts). */
	| { kind: "checkoutRunsProgram"; program: CheckoutProgram }
	| { kind: "exists"; path: string }
	| { kind: "createFailed"; osMessage: string };

/** What blocks exit_worktree from removing a worktree without `discard_changes`. */
export type RemoveBlocker =
	| { kind: "uncommitted"; files: string }
	| { kind: "commitsAhead"; count: string; branch: string }
	| { kind: "baseUnknown" }
	| { kind: "statusUnknown" };

export interface WorktreeText {
	descriptions: {
		/** `configDir`: the project config folder worktrees go under (`.claude`, or `.onecode` in independent mode). */
		enter_worktree(configDir: string): string;
		exit_worktree: string;
	};
	params: {
		enter: Record<"name" | "path", string>;
		exit: Record<"action" | "discard_changes", string>;
	};
	/** Search terms for `tool_search`, per tool, beyond its name and description. */
	searchKeywords: Record<"enter_worktree" | "exit_worktree", string[]>;
	/** The sticky reminder while a session is in a worktree. */
	reminder(session: WorktreeSessionView): string;
	/** A restored session's worktree no longer exists, so the session left it. */
	missingOnRestore(session: WorktreeSessionView): string;
	/** A tool call was refused because the active worktree no longer exists. */
	activeMissing(session: WorktreeSessionView): string;
	enter: {
		failed(failure: EnterWorktreeFailure): string;
		/** `branchError`: git's first line when the branch could not be read. */
		switched(p: { session: WorktreeSessionView; branchError?: string }): string;
		created(p: { session: WorktreeSessionView; baseCommit: string }): string;
	};
	exit: {
		noSession: string;
		/** `exists`: whether the worktree is still on disk. */
		kept(p: { session: WorktreeSessionView; exists: boolean }): string;
		notCreatedHere(session: WorktreeSessionView): string;
		removeRefused(p: { session: WorktreeSessionView; blockers: readonly RemoveBlocker[] }): string;
		removeFailed(osMessage: string): string;
		branchDeleteFailed(p: { session: WorktreeSessionView; branch: string; osMessage: string }): string;
		removed(session: WorktreeSessionView): string;
	};
}

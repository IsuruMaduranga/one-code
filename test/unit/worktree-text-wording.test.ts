/**
 * The worktree tools' results: enter_worktree announcing the git-isolation
 * guard (that the tool returns it is tested in worktree-wiring.test.ts), and
 * the results the golden snapshot cannot reach offline: a failing git, a
 * checkout filter, a worktree deleted under the session. The golden snapshot
 * pins the bytes of every other result.
 */
import { describe, expect, it } from "vitest";
import { worktreeResultText } from "../../extensions/safety/worktree/text.ts";

const session = { path: "/repo/.claude/worktrees/wt", branch: "wt", originalCwd: "/repo" };

describe("the worktree result text", () => {
	it("announces the git-isolation guard when it creates a worktree", () => {
		expect(worktreeResultText.enter.created({ session: { path: "/repo/.claude/worktrees/feature", branch: "feature", originalCwd: "/repo" }, baseCommit: "abc123" })).toContain(
			"Git commands aimed at the main checkout or another worktree of this repository are refused until you exit.",
		);
	});

	it("words the enter failures the offline run cannot reach", () => {
		expect(worktreeResultText.enter.failed({ kind: "notARepository" })).toBe("enter_worktree needs a git repository; this directory is not one.");
		expect(worktreeResultText.enter.failed({ kind: "checkoutRunsProgram", program: { kind: "configSetsProgram", key: "core.fsmonitor" } })).toBe(
			"Could not create worktree safely: the checkout's git config sets core.fsmonitor, which names a program git runs. Create it with a permission-reviewed `git worktree add` command, then enter it with `path`.",
		);
		expect(worktreeResultText.enter.failed({ kind: "checkoutRunsProgram", program: { kind: "submoduleConfig" } })).toContain("a submodule's git config cannot be read.");
		expect(worktreeResultText.enter.failed({ kind: "invalidName", name: "a/../b", problem: "dotSegment" })).toBe('Invalid worktree name "a/../b": segments may not be . or ..');
		expect(worktreeResultText.enter.failed({ kind: "invalidName", name: "", problem: "length" })).toBe('Invalid worktree name "": name must be 1-64 characters');
	});

	it("reports an unreadable branch on a switch and still says the session moved", () => {
		expect(worktreeResultText.enter.switched({ session: { ...session, branch: undefined }, branchError: "fatal: bad HEAD" })).toBe(
			"Switched into existing worktree /repo/.claude/worktrees/wt. Its branch could not be read (fatal: bad HEAD). All work now happens there; exit_worktree returns to /repo. Git commands aimed at the main checkout or another worktree of this repository are refused until you exit.",
		);
	});

	it("tells the model when the worktree is gone and how to get back", () => {
		expect(worktreeResultText.missingOnRestore(session)).toBe("Left worktree session; back in /repo. The worktree at /repo/.claude/worktrees/wt no longer exists.");
		expect(worktreeResultText.activeMissing(session)).toContain('Use exit_worktree with action: "keep" to return to /repo');
		expect(worktreeResultText.exit.kept({ session, exists: false })).toBe("Left worktree session; back in /repo. The worktree at /repo/.claude/worktrees/wt no longer exists. No branch was removed.");
	});

	it("words the removal failures and the blockers git could not check", () => {
		expect(worktreeResultText.exit.removeRefused({ session, blockers: [{ kind: "baseUnknown" }, { kind: "statusUnknown" }] })).toBe(
			'Refusing to remove /repo/.claude/worktrees/wt:\n\nCould not verify commits without the original branch and base commit.\n\nCould not verify the worktree is clean.\n\nConfirm with the user, then re-invoke with discard_changes: true — or exit with action: "keep".',
		);
		expect(worktreeResultText.exit.removeFailed("fatal: locked")).toBe("Could not remove the worktree: fatal: locked");
		expect(worktreeResultText.exit.branchDeleteFailed({ session, branch: "wt", osMessage: "fatal: no" })).toBe(
			"Removed worktree /repo/.claude/worktrees/wt; back in /repo, but could not delete branch wt: fatal: no. Inspect the branch before removing it manually.",
		);
		expect(worktreeResultText.exit.removed({ ...session, branch: undefined })).toBe("Removed worktree /repo/.claude/worktrees/wt; back in /repo.");
	});
});

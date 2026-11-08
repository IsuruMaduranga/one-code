/**
 * One Code's wording of enter_worktree's result: the git-isolation guard is
 * announced on entry, not first met as a refusal. That the tool returns
 * this text is tested in test/unit/worktree-wiring.test.ts.
 */
import { describe, expect, it } from "vitest";
import { worktree } from "../text/worktree/index.ts";

describe("enter_worktree's result in One Code's words", () => {
	it("announces the git-isolation guard when it creates a worktree", () => {
		const session = { path: "/repo/.claude/worktrees/feature", branch: "feature", originalCwd: "/repo" };
		expect(worktree.enter.created({ session, baseCommit: "abc123" })).toContain(
			"Git commands aimed at the main checkout or another worktree of this repository are refused until you exit.",
		);
	});
});

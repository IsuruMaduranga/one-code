/**
 * One Code's worktree-tool wording (profile/text/worktree/): the config
 * folder enter_worktree's description names. The base's results are checked
 * in test/unit/worktree-text-wording.test.ts.
 */
import { describe, expect, it } from "vitest";
import { worktree } from "../text/worktree/index.ts";

describe("One Code's worktree text", () => {
	it("names the config folder the mode puts worktrees in", () => {
		expect(worktree.descriptions.enter_worktree(".onecode")).toContain("inside `.onecode/worktrees/`");
		expect(worktree.descriptions.enter_worktree(".claude")).toContain("inside `.claude/worktrees/`");
	});
});

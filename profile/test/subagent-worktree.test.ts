/** One Code's wording for a kept isolation worktree (profile/text/subagents/). The base's worktree handling is in test/unit/subagent-worktree.test.ts. */
import { describe, expect, it } from "vitest";
import { keptWorktreeNote } from "../../extensions/subagents/worktree.ts";

describe("One Code's kept-worktree note", () => {
	it("names the branch", () => {
		expect(keptWorktreeNote("/tmp/wt", "cc-subagent/x")).toContain("/tmp/wt on branch cc-subagent/x");
	});
});

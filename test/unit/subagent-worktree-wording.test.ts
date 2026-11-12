/**
 * The words of the note for a kept isolation worktree. The worktree handling:
 * subagent-worktree.test.ts.
 */
import { describe, expect, it } from "vitest";
import { keptWorktreeNote } from "../../extensions/lib/agents/agent-worktree.ts";

describe("the kept-worktree note", () => {
	it("names the branch", () => {
		expect(keptWorktreeNote("/tmp/wt", "cc-subagent/x")).toContain("/tmp/wt on branch cc-subagent/x");
	});
});

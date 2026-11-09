/**
 * One Code's wording of the worktree write guards' refusals (its profile's
 * `worktreeGuard` group): the worktree, the shared checkout and the path to
 * write instead. The decisions alone, on any profile, are tested in
 * test/unit/worktree-isolation.test.ts.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeIsolation, worktreeBashWriteGuardReason, worktreeWriteGuardReason } from "../../extensions/lib/agents/worktree-isolation.ts";
import type { WorktreeGuardRefusal } from "../../extensions/safety/worktree/text.ts";
import { worktreeGuard } from "../text/worktree/guard.ts";

const worded = (refusal: WorktreeGuardRefusal | undefined) => refusal && worktreeGuard.refusal(refusal);

describe("worktree write refusals in One Code's words", () => {
	const base = { cwd: "/tmp/cc-wt-x/tree", isolation: describeIsolation("/tmp/cc-wt-x/tree", "/repo"), home: "/home/u" };

	it("names the worktree, the shared checkout and the path to write instead", () => {
		const reason = worded(worktreeWriteGuardReason({ ...base, toolName: "edit", target: "/repo/src/a.ts" }));
		expect(reason).toContain("isolated in the worktree /tmp/cc-wt-x/tree");
		expect(reason).toContain("/repo/src/a.ts is in the shared checkout /repo");
		expect(reason).toContain("Refusing the write");
		expect(reason).toContain(`Write the corresponding path there instead: ${join("/tmp/cc-wt-x/tree", "src", "a.ts")}`);
	});

	it("says a shell command does the writing", () => {
		const reason = worded(worktreeBashWriteGuardReason({ command: "echo hi > /repo/notes.txt", cwd: base.cwd, isolation: base.isolation, home: base.home }));
		expect(reason).toContain("this command writes to /repo/notes.txt");
		expect(reason).toContain(`there instead: ${join("/tmp/cc-wt-x/tree", "notes.txt")}`);
	});
});

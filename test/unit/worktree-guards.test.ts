import { describe, expect, it } from "vitest";
import { worktreeBashGuardReason } from "../../extensions/worktree/guards.ts";

const WT = "/repo/.claude/worktrees/wt1";
const guard = (command: string) => worktreeBashGuardReason({ command, worktreePath: WT, sharedRoot: "/repo" });

describe("worktree git-isolation guard", () => {
	it("allows git that targets the worktree", () => {
		expect(guard("git status")).toBeUndefined();
		expect(guard("git add . && git commit -m 'Add guards'")).toBeUndefined();
		expect(guard(`git -C ${WT} log --oneline -3`)).toBeUndefined();
		expect(guard("cd src && git add .")).toBeUndefined();
	});

	it("refuses git fed its arguments from stdin at runtime", () => {
		const reason = guard("git merge-base master feature | xargs git log --oneline -1") ?? "";
		expect(reason).toContain("stdin at runtime (xargs)");
		expect(reason).toContain("must target its own worktree");
		expect(guard("ls | parallel git add")).toContain("parallel");
		expect(guard("find . -name '*.orig' -exec git rm {} \\;")).toContain("find -exec");
	});

	it("leaves xargs without git alone", () => {
		expect(guard("find . -name '*.tmp' | xargs rm")).toBeUndefined();
	});

	it("refuses git pointed at the shared checkout or a sibling worktree", () => {
		expect(guard("git -C /repo status")).toContain("targets /repo");
		expect(guard("git -C ../wt2 log")).toContain("/repo/.claude/worktrees/wt2");
		expect(guard("git --git-dir=/repo/.git log")).toBeDefined();
		expect(guard("git --work-tree /repo status")).toBeDefined();
		expect(guard("cd /repo && git status")).toBeDefined();
	});

	it("leaves git against an unrelated repository alone", () => {
		expect(guard("git -C /Users/x/other-repo pull")).toBeUndefined();
	});

	it("leaves non-git commands outside the worktree alone", () => {
		expect(guard("cd /repo && ls -la")).toBeUndefined();
		expect(guard("cat /repo/package.json")).toBeUndefined();
	});

	it("refuses a git target computed at runtime", () => {
		expect(guard('git -C "$DIR" status')).toContain("cannot be verified");
		expect(guard("cd $BUILD_DIR && git status")).toContain("unverifiable");
	});

	it("refuses an unparseable command only when it involves git", () => {
		expect(guard('git commit -m "unterminated')).toContain("too complex to verify");
		expect(guard('echo "unterminated')).toBeUndefined();
	});

	it("names the worktree in every refusal", () => {
		const reason = guard("git -C /repo status") ?? "";
		expect(reason).toContain(`isolated in the worktree ${WT}`);
		expect(reason).toContain(`against ${WT}`);
	});
});

describe("worktree shared-stash guard", () => {
	it("refuses stash forms that collide with parallel sessions", () => {
		expect(guard("git stash")).toContain("untagged");
		expect(guard("git stash push -u")).toContain("untagged");
		expect(guard("git stash pop")).toContain("another session's entry");
		expect(guard("git stash clear")).toContain("every session's stashes");
		expect(guard("git stash drop")).toContain("stash@{0}");
	});

	it("allows the tagged, apply-by-ref workflow", () => {
		expect(guard('git stash push -u -m "wt1-wip"')).toBeUndefined();
		expect(guard("git stash list --format='%H %gs'")).toBeUndefined();
		expect(guard("git stash apply abc1234")).toBeUndefined();
		expect(guard("git stash drop stash@{2}")).toBeUndefined();
		expect(guard("git stash show -p")).toBeUndefined();
	});

	it("gives the full recipe in the refusal", () => {
		const reason = guard("git stash pop") ?? "";
		expect(reason).toContain('git stash push -u -m "<unique-tag>"');
		expect(reason).toContain("git stash apply <sha>");
	});

	it("does not police another repository's stash", () => {
		expect(guard("git -C /Users/x/other-repo stash pop")).toBeUndefined();
	});
});

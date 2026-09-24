import { resolve } from "node:path";
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

	it("refuses git fed its arguments from stdin at runtime, in Claude Code's wording", () => {
		const reason = guard("git merge-base master feature | xargs git log --oneline -1") ?? "";
		expect(reason).toContain("stdin at runtime (xargs/parallel)");
		expect(reason).toContain("must target its own worktree");
		expect(reason).toContain(`Run the equivalent from ${WT} without the redirect.`);
		expect(guard("ls | parallel git add")).toContain("stdin at runtime (xargs/parallel)");
		expect(guard("find . -name '*.orig' -exec git rm {} \\;")).toContain("find -exec");
	});

	it("leaves xargs without git alone", () => {
		expect(guard("find . -name '*.tmp' | xargs rm")).toBeUndefined();
	});

	it("refuses git pointed at the shared checkout or a sibling worktree", () => {
		expect(guard("git -C /repo status")).toContain(`targets ${resolve("/repo")}`);
		expect(guard("git -C ../wt2 log")).toContain(resolve("/repo/.claude/worktrees/wt2"));
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

	it("sees a -C that follows --config-env", () => {
		expect(guard("git --config-env foo=BAR -C /repo status")).toContain(`targets ${resolve("/repo")}`);
	});

	it("sees through cd options to the real destination", () => {
		expect(guard("cd -P /repo && git status")).toBeDefined();
		expect(guard("cd -P src && git status")).toBeUndefined();
	});

	it("re-anchors on a later absolute cd after an unknown one", () => {
		expect(guard(`cd $X && ls; cd ${WT} && git status`)).toBeUndefined();
		expect(guard("cd $X && ls; cd /repo && git status")).toBeDefined();
	});

	it("refuses git in a line that changes directory inside a loop (PR #12 review)", () => {
		expect(guard("for d in a b; do git status; cd ../../..; done")).toContain("inside a loop");
		expect(guard("for d in a b; do git status; builtin cd ../../..; done")).toContain("inside a loop");
		expect(guard("for d in a b; do cd $d; done")).toBeUndefined();
		expect(guard("for d in a b; do bash -c 'git status'; cd ../../..; done")).toContain("inside a loop");
		expect(guard("for d in a b; do sh -c 'git status'; cd ../../..; done")).toContain("inside a loop");
	});

	it("refuses git after a cd in the last pipeline member, which lastpipe runs in this shell", () => {
		expect(guard("shopt -s lastpipe; true | cd /repo; git status")).toContain("last command of a pipeline");
		expect(guard("true | cd /repo")).toBeUndefined();
		// Only git after the pipeline, spelled any way, and never a cd inside a subshell (PR #13 review).
		expect(guard("shopt -s lastpipe; true | cd /repo; gi\\t status")).toContain("last command of a pipeline");
		expect(guard("git status; true | cd /tmp")).toBeUndefined();
		expect(guard("true | cd /tmp; echo git")).toBeUndefined();
		expect(guard('true | echo "$(cd /repo)"; git status')).toBeUndefined();
		expect(guard("true | (cd /repo); git status")).toBeUndefined();
		expect(guard('echo "$(true | cd /tmp)"; git status')).toBeUndefined();
		// git in a script a shell runs counts (PR #13 review).
		expect(guard("shopt -s lastpipe; true | cd /repo; bash -c 'git status'")).toContain("last command of a pipeline");
		expect(guard("shopt -s lastpipe; true | cd /repo; sh -c 'gi\\t status'")).toContain("last command of a pipeline");
	});

	it("judges a script a shell or eval runs from the directory it starts in (PR #13 review)", () => {
		expect(guard("bash -c 'cd /repo && git status'")).toContain(`targets ${resolve("/repo")}`);
		expect(guard("sh -c 'git -C /repo status'")).toContain(`targets ${resolve("/repo")}`);
		expect(guard("cd /repo && bash -c 'git status'")).toContain(`targets ${resolve("/repo")}`);
		expect(guard(`cd /tmp && bash -c 'cd ${WT} && git status'`)).toBeUndefined();
		expect(guard("bash -c 'git stash'")).toContain("stash stack is shared");
		expect(guard("bash -c 'git status' && git log")).toBeUndefined();
		// A shell's script runs in a child; eval runs in this shell, so its cd moves later git.
		expect(guard("bash -c 'cd /repo'; git status")).toBeUndefined();
		expect(guard("eval 'cd /repo'; git status")).toContain("unverifiable");
		expect(guard("eval cd /repo '&&' git status")).toContain(`targets ${resolve("/repo")}`);
	});

	it("treats a globbed cd target as an unknown directory (PR #12 review)", () => {
		expect(guard("cd /r*po && git status")).toBeDefined();
		expect(guard("cd /re?o && git stash pop")).toBeDefined();
	});

	it("follows a wrapped cd (PR #12 review)", () => {
		expect(guard("builtin cd /repo && git status")).toBeDefined();
		expect(guard("command cd /repo && git status")).toBeDefined();
	});

	it("scopes a subshell cd to the subshell", () => {
		expect(guard('(cd /repo && cat package.json); git commit -am "done"')).toBeUndefined();
		expect(guard("(cd /repo && git status)")).toBeDefined();
	});

	it("keeps a parenthesised argument value intact", () => {
		expect(guard("git -C '(weird)' status")).toBeUndefined();
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
		expect(guard("git stash push -um wt1-wip")).toBeUndefined();
		expect(guard("git stash list --format='%H %gs'")).toBeUndefined();
		expect(guard("git stash apply abc1234")).toBeUndefined();
		expect(guard("git stash drop stash@{2}")).toBeUndefined();
		expect(guard("git stash show -p")).toBeUndefined();
	});

	it("catches a subshell-wrapped stash", () => {
		expect(guard("(git stash)")).toContain("untagged");
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

describe.skipIf(process.platform !== "win32")("worktree git-isolation guard: Git Bash path spellings on Windows", () => {
	// `/repo` resolves onto the current drive; the MSYS spelling of that same path.
	const drive = resolve("/").charAt(0).toLowerCase();

	it("refuses git pointed at the shared checkout spelled /<drive>/repo", () => {
		expect(guard(`git -C /${drive}/repo status`)).toContain(`targets ${resolve("/repo")}`);
		expect(guard(`cd /${drive}/repo && git status`)).toBeDefined();
		expect(guard(`git --git-dir=/${drive}/repo/.git log`)).toBeDefined();
	});

	it("leaves git against an unrelated repository spelled /<drive>/… alone", () => {
		expect(guard(`git -C /${drive}/Users/x/other-repo pull`)).toBeUndefined();
	});
});

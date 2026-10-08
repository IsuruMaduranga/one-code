import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreePowershellGuardReason } from "../../extensions/worktree/powershell-guards.ts";

const WT = "/repo/.claude/worktrees/wt1";
const guard = (command: string) => worktreePowershellGuardReason({ command, worktreePath: WT, sharedRoot: "/repo" });

describe("worktree git-isolation guard for PowerShell", () => {
	it("refuses git aimed at a linked worktree outside the shared checkout", () => {
		const outside = resolve("/elsewhere/wt2");
		const withSiblings = (command: string) => worktreePowershellGuardReason({ command, worktreePath: WT, sharedRoot: "/repo", otherWorktrees: [resolve("/repo"), resolve(WT), outside] });
		expect(withSiblings("git -C /elsewhere/wt2 status")).toContain("another worktree of the same repository");
		expect(withSiblings("git status")).toBeUndefined();
		expect(guard("git -C /elsewhere/wt2 status")).toBeUndefined();
	});

	it("allows git that targets the worktree, and lines without git", () => {
		expect(guard("git status")).toBeUndefined();
		expect(guard("git add .; git commit -m 'Add guards'")).toBeUndefined();
		expect(guard(`git -C ${WT} log --oneline -3`)).toBeUndefined();
		expect(guard("Set-Location src; git add .")).toBeUndefined();
		expect(guard("cd src; git status | Out-String")).toBeUndefined();
		expect(guard("Set-Location /repo; Remove-Item build -Recurse")).toBeUndefined();
		expect(guard("git.exe status")).toBeUndefined();
	});

	it("refuses git aimed at the shared checkout or a sibling worktree", () => {
		expect(guard("Set-Location /repo; git stash; git reset --hard")).toContain(`targets ${resolve("/repo")}`);
		expect(guard("cd /repo; git checkout main")).toContain("shared checkout");
		expect(guard("Set-Location -LiteralPath '/repo' -ErrorAction Stop; git status")).toContain("shared checkout");
		expect(guard("Push-Location ..\\..\\..; git status".replace(/\\/g, "/"))).toContain("shared checkout");
		expect(guard("git -C /repo checkout main")).toContain("shared checkout");
		expect(guard("GIT -C /repo checkout main")).toContain("shared checkout");
		expect(guard("git --git-dir=/repo/.git reset --hard")).toContain("shared checkout");
		expect(guard("git --work-tree /repo status")).toContain("shared checkout");
		expect(guard("git -c core.worktree=/repo checkout .")).toContain("shared checkout");
		expect(guard("git -C ../wt2 log")).toContain(resolve("/repo/.claude/worktrees/wt2"));
	});

	it("leaves git against an unrelated repository alone", () => {
		expect(guard("git -C /Users/x/other-repo pull")).toBeUndefined();
		expect(guard("Set-Location /Users/x/other-repo; git pull")).toBeUndefined();
	});

	it("refuses git whose repository is decided at runtime", () => {
		expect(guard("Set-Location $env:REPO; git status")).toContain("unverifiable");
		expect(guard("Pop-Location; git status")).toContain("unverifiable");
		expect(guard("git -C $root status")).toContain("computes its repository target at runtime");
		expect(guard("git --config-env=core.worktree=WT status")).toContain("at runtime");
		expect(guard("$env:GIT_DIR = '/repo/.git'; git log")).toContain("GIT_DIR");
		expect(guard("$env:GIT_WORK_TREE='/repo'; git checkout .")).toContain("GIT_WORK_TREE");
	});

	it("refuses git it cannot follow: script blocks, call operators, nested shells, bad quoting", () => {
		expect(guard("Get-ChildItem | ForEach-Object { git -C $_ status }")).toContain("a script block");
		expect(guard("& git -C /repo status")).toContain("call (&)");
		expect(guard("Invoke-Expression 'git reset --hard'")).toContain("invoke-expression");
		expect(guard("cmd /c git reset --hard")).toContain("nested `cmd` shell");
		expect(guard("git commit -m 'unclosed")).toContain("quoting could not be followed");
	});

	it("refuses the shared-stash forms, as in bash", () => {
		expect(guard("git stash")).toContain("untagged");
		expect(guard("git stash pop")).toContain("another session's entry");
		expect(guard("git stash branch tmp")).toContain("stash@{0}");
		expect(guard("git stash push -u -m 'wt1-wip'")).toBeUndefined();
	});
});

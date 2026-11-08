/**
 * The PowerShell worktree guard's decisions
 * (extensions/worktree/powershell-guards.ts): which lines a worktree-isolated
 * session refuses, and why, as the refusal data the profile words. One Code's
 * wording of each refusal is tested in
 * profile/test/worktree-guards-wording.test.ts.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreePowershellGuardReason } from "../../extensions/worktree/powershell-guards.ts";

const WT = "/repo/.claude/worktrees/wt1";
const guard = (command: string) => worktreePowershellGuardReason({ command, worktreePath: WT, sharedRoot: "/repo" });

describe("worktree git-isolation guard for PowerShell", () => {
	it("refuses git aimed at a linked worktree outside the shared checkout", () => {
		const outside = resolve("/elsewhere/wt2");
		const withSiblings = (command: string) => worktreePowershellGuardReason({ command, worktreePath: WT, sharedRoot: "/repo", otherWorktrees: [resolve("/repo"), resolve(WT), outside] });
		expect(withSiblings("git -C /elsewhere/wt2 status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: outside } });
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
		expect(guard("Set-Location /repo; git stash; git reset --hard")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("cd /repo; git checkout main")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("Set-Location -LiteralPath '/repo' -ErrorAction Stop; git status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("Push-Location ..\\..\\..; git status".replace(/\\/g, "/"))).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("git -C /repo checkout main")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("GIT -C /repo checkout main")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("git --git-dir=/repo/.git reset --hard")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo/.git") } });
		expect(guard("git --work-tree /repo status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("git -c core.worktree=/repo checkout .")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo") } });
		expect(guard("git -C ../wt2 log")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve("/repo/.claude/worktrees/wt2") } });
	});

	it.each([
		['git --git-dir="/repo/.git" status', "/repo/.git"],
		["git --work-tree='/repo' status", "/repo"],
		['git -c core.worktree="/repo" status', "/repo"],
		['git -C /"repo" status', "/repo"],
		['Set-Location -LiteralPath:"/repo"; git status', "/repo"],
	])("refuses quoted fragments in repository paths: %s", (command, target) => {
		expect(guard(command)).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "sharedTarget", target: resolve(target) } });
	});

	it("keeps spaces and escaped quotes inside quoted repository path fragments", () => {
		const sharedRoot = resolve("/repo with space's");
		const worktreePath = resolve(sharedRoot, ".claude/worktrees/own");
		const command = `git --git-dir='${sharedRoot.replace(/'/g, "''")}/.git' status`;
		expect(worktreePowershellGuardReason({ command, worktreePath, sharedRoot })).toEqual({
			kind: "gitTarget",
			worktreePath,
			problem: { kind: "sharedTarget", target: resolve(sharedRoot, ".git") },
		});
		expect(guard(`git --work-tree="${WT}" status`)).toBeUndefined();
	});

	it("leaves git against an unrelated repository alone", () => {
		expect(guard("git -C /Users/x/other-repo pull")).toBeUndefined();
		expect(guard("Set-Location /Users/x/other-repo; git pull")).toBeUndefined();
	});

	it("refuses git whose repository is decided at runtime", () => {
		expect(guard("Set-Location $env:REPO; git status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "precedingCd" } });
		expect(guard("Pop-Location; git status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "precedingCd" } });
		expect(guard("git -C $root status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "runtimeFlag", flag: "-C" } });
		expect(guard("git --config-env=core.worktree=WT status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "configEnv" } });
		expect(guard("$env:GIT_DIR = '/repo/.git'; git log")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "repositoryVariable" } });
		expect(guard("$env:GIT_WORK_TREE='/repo'; git checkout .")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "repositoryVariable" } });
	});

	it("refuses git it cannot follow: script blocks, call operators, nested shells, bad quoting", () => {
		expect(guard("Get-ChildItem | ForEach-Object { git -C $_ status }")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "besideSyntax", syntax: "a script block" } });
		expect(guard("& git -C /repo status")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "besideSyntax", syntax: "the call (&) or dot-source operator" } });
		expect(guard("Invoke-Expression 'git reset --hard'")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "besideSyntax", syntax: "`invoke-expression`" } });
		expect(guard("cmd /c git reset --hard")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "besideSyntax", syntax: "a nested `cmd` shell" } });
		expect(guard("git commit -m 'unclosed")).toEqual({ kind: "gitTarget", worktreePath: WT, problem: { kind: "unfollowedQuoting" } });
	});

	it("refuses the shared-stash forms, as in bash", () => {
		expect(guard("git stash")).toEqual({ kind: "stash", risk: "untagged", command: "git stash" });
		expect(guard("git stash pop")).toEqual({ kind: "stash", risk: "pop", command: "git stash pop" });
		expect(guard("git stash branch tmp")).toEqual({ kind: "stash", risk: "branch", command: "git stash branch" });
		expect(guard("git stash push -u -m 'wt1-wip'")).toBeUndefined();
	});
});

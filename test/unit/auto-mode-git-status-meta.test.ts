import { describe, expect, it } from "vitest";
import { destructiveCategory, gitStatusMeta, gitStatusMetaArgs, reachesHiddenWork, wantsGitStatusMeta } from "../../extensions/auto-mode/git-status-meta.ts";
import { renderTranscript } from "../../extensions/auto-mode/transcript.ts";

describe("the transcript's gitStatus line", () => {
	it("goes above bash commands that can destroy uncommitted work", () => {
		for (const command of ["git reset --hard HEAD~1", "git checkout .", "git restore -- .", "git clean -fdx", "rm -rf dist", "rm -r build", "rm -f a.txt", "ls && rm -fr x"]) {
			expect(wantsGitStatusMeta("bash", command), command).toBe(true);
		}
		for (const command of ["git status", "git clean -n", "git clean --dry-run -f", "rm a.txt", "git checkout main", "git stash drop", "git branch -D x"]) {
			expect(wantsGitStatusMeta("bash", command), command).toBe(false);
		}
	});

	it("adds the line for any destructive part of a compound command", () => {
		// The command is named by its first match (a force push), but the rm later
		// in the line still destroys uncommitted work.
		expect(destructiveCategory("bash", "git push --force origin x && rm -rf y")).toBe("git_force_push");
		expect(wantsGitStatusMeta("bash", "git push --force origin x && rm -rf y")).toBe(true);
	});

	it("goes above PowerShell removals too", () => {
		expect(wantsGitStatusMeta("powershell", "Remove-Item -Recurse -Force dist")).toBe(true);
		expect(wantsGitStatusMeta("powershell", "Clear-Content *.log")).toBe(true);
		expect(wantsGitStatusMeta("powershell", "Remove-Item a.txt")).toBe(false);
	});

	it("summarizes porcelain output as clean or counts", () => {
		expect(gitStatusMeta("")).toEqual({ clean: true });
		expect(gitStatusMeta("M  staged.ts\n M modified.ts\nMM both.ts\n?? new.txt\n")).toEqual({ staged: 2, modified: 2, untracked: 1 });
	});

	it("withholds clean when only ignored entries remain", () => {
		expect(gitStatusMeta("!! .env\n!! node_modules/\n")).toBeUndefined();
		expect(gitStatusMeta("?? new.txt\n!! .env\n")).toEqual({ staged: 0, modified: 0, untracked: 1 });
		// A dirty submodule (--ignore-submodules=none) is a modification.
		expect(gitStatusMeta(" M vendor/sub\n")).toEqual({ staged: 0, modified: 1, untracked: 0 });
		// Only a command that reaches ignored files asks git to list them.
		expect(gitStatusMetaArgs(false)).toEqual(["status", "--porcelain", "--ignore-submodules=dirty", "--untracked-files=normal"]);
		expect(gitStatusMetaArgs(true)).toContain("--ignored=matching");
	});

	it("knows which commands reach ignored files and submodule work", () => {
		for (const command of ["rm -rf dist", "rm -f .env", "git clean -fdx", "git clean -fX", "ls && rm -r build"]) {
			expect(reachesHiddenWork("bash", command), command).toBe(true);
		}
		for (const command of ["git reset --hard", "git checkout .", "git restore .", "git clean -fd", "git clean -nfx"]) {
			expect(reachesHiddenWork("bash", command), command).toBe(false);
		}
		expect(reachesHiddenWork("powershell", "Remove-Item -Recurse -Force dist")).toBe(true);
		expect(reachesHiddenWork("powershell", "git reset --hard")).toBe(false);
	});

	it("renders directly above the command it describes", () => {
		const text = renderTranscript([
			{ kind: "user", text: "reset it" },
			{ kind: "meta", gitStatus: { staged: 0, modified: 1, untracked: 0 } },
			{ kind: "tool", tool: "bash", input: { command: "git reset --hard" } },
		]);
		expect(text.split("\n").slice(2, 4)).toEqual(['{"meta":{"gitStatus":{"staged":0,"modified":1,"untracked":0}}}', '{"Bash":"git reset --hard"}']);
	});
});

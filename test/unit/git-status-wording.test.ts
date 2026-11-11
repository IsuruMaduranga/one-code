/**
 * The git status block's words: its layout, the main-branch line, a dropped
 * user line, a clean tree and the clip note. What the base gathers and clips:
 * git-status.test.ts.
 */
import { describe, expect, it } from "vitest";
import { collectGitStatus, formatGitStatus, GIT_STATUS_MAX_CHARS } from "../../extensions/lib/context/git-status.ts";
import { fakeRunner, IN_WORK_TREE } from "./helpers/git-runner.ts";

describe("formatGitStatus", () => {
	it("assembles CC's block byte-for-byte", () => {
		const block = formatGitStatus({
			branch: "feature/x",
			mainBranch: "main",
			user: "Ada Lovelace",
			status: "M src/a.ts\n?? new.txt",
			commits: "abc123 First\ndef456 Second",
		});
		expect(block).toBe(
			[
				"# gitStatus",
				"This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
				"",
				"Current branch: feature/x",
				"",
				"Main branch (you will usually use this for PRs): main",
				"",
				"Git user: Ada Lovelace",
				"",
				"Status:",
				"M src/a.ts",
				"?? new.txt",
				"",
				"Recent commits:",
				"abc123 First",
				"def456 Second",
			].join("\n"),
		);
	});
});

describe("collectGitStatus", () => {
	const base = IN_WORK_TREE;

	it("derives the main branch from origin/HEAD, stripping the origin/ prefix", () => {
		const block = collectGitStatus(
			"/x",
			fakeRunner({ ...base, "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk" }),
		);
		expect(block).toContain("Main branch (you will usually use this for PRs): trunk");
		expect(block).toContain("Current branch: feature/x");
	});

	it("falls back to a local main, then master, then the current branch", () => {
		const withMain = fakeRunner({ ...base, "rev-parse --verify --quiet main": "sha" });
		expect(collectGitStatus("/x", withMain)).toContain("PRs): main");

		const withMaster = fakeRunner({ ...base, "rev-parse --verify --quiet master": "sha" });
		expect(collectGitStatus("/x", withMaster)).toContain("PRs): master");

		// No origin/HEAD and no local main/master: the current branch stands in.
		expect(collectGitStatus("/x", fakeRunner(base))).toContain("PRs): feature/x");
	});

	it("degrades a failing field to empty rather than dropping the block", () => {
		const noUser = { ...base };
		delete (noUser as Record<string, string>)["config user.name"];
		const block = collectGitStatus("/x", fakeRunner(noUser));
		// An empty user name drops the line, as Claude Code does.
		expect(block).not.toContain("Git user:");
		expect(block).toContain("PRs): feature/x\n\nStatus:\nM a.ts\n");
	});

	it("says (clean) for a clean tree", () => {
		const block = collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": "" }));
		expect(block).toContain("\n\nStatus:\n(clean)\n\nRecent commits:\n");
	});

	it("clips a long status at 2,000 characters with Claude Code's note", () => {
		const lines = Array.from({ length: 5000 }, (_, i) => `?? generated/file-${i}.txt`);
		const status = lines.join("\n");
		const block = collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": status })) ?? "";
		const note =
			'\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using bash)';
		expect(block).toContain(`Status:\n${status.substring(0, GIT_STATUS_MAX_CHARS)}${note}\n\nRecent commits:\nabc First`);
		expect(block.length).toBeLessThan(2600);
		// The note names the shell tool the model has.
		expect(collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": status }), "powershell")).toContain(
			'run "git status" using powershell)',
		);
		// At the limit exactly, nothing is cut.
		const exact = "x".repeat(GIT_STATUS_MAX_CHARS);
		expect(collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": exact }))).toContain(`Status:\n${exact}\n\nRecent`);
	});
});

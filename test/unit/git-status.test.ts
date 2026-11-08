/**
 * The git status block at the start of a conversation (lib/git-status.ts):
 * the snapshot the base gathers from git, clipped where the status is long,
 * in the profile's words. One Code's block: profile/test/git-status-wording.test.ts.
 */
import { describe, expect, it } from "vitest";
import { collectGitStatus, formatGitStatus, GIT_STATUS_MAX_CHARS, type GitSnapshot } from "../../extensions/lib/git-status.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import { fakeRunner, IN_WORK_TREE } from "./helpers/git-runner.ts";

const context = requireText("context");
/** The profile's block for a snapshot taken at the start of a conversation. */
const block = (snapshot: GitSnapshot) => context.gitStatus({ snapshot, at: "start" });

describe("formatGitStatus", () => {
	it("is the profile's block for the snapshot", () => {
		const snapshot = { branch: "feature/x", mainBranch: "main", user: "Ada Lovelace", status: "M src/a.ts\n?? new.txt", commits: "abc123 First\ndef456 Second" };
		expect(formatGitStatus(snapshot)).toBe(block(snapshot));
	});
});

describe("collectGitStatus", () => {
	const base = IN_WORK_TREE;
	const snapshot = { branch: "feature/x", mainBranch: "feature/x", user: "Ada", status: "M a.ts", commits: "abc First" };

	it("returns null outside a git work tree", () => {
		expect(collectGitStatus("/x", fakeRunner({}))).toBeNull();
	});

	it("derives the main branch from origin/HEAD, stripping the origin/ prefix", () => {
		const collected = collectGitStatus("/x", fakeRunner({ ...base, "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk" }));
		expect(collected).toBe(block({ ...snapshot, mainBranch: "trunk" }));
	});

	it("falls back to a local main, then master, then the current branch", () => {
		const withMain = fakeRunner({ ...base, "rev-parse --verify --quiet main": "sha" });
		expect(collectGitStatus("/x", withMain)).toBe(block({ ...snapshot, mainBranch: "main" }));

		const withMaster = fakeRunner({ ...base, "rev-parse --verify --quiet master": "sha" });
		expect(collectGitStatus("/x", withMaster)).toBe(block({ ...snapshot, mainBranch: "master" }));

		// No origin/HEAD and no local main/master: the current branch stands in.
		expect(collectGitStatus("/x", fakeRunner(base))).toBe(block(snapshot));
	});

	it("degrades a failing field to empty rather than dropping the block", () => {
		const noUser = { ...base };
		delete (noUser as Record<string, string>)["config user.name"];
		expect(collectGitStatus("/x", fakeRunner(noUser))).toBe(block({ ...snapshot, user: "" }));
	});

	it("passes a clean tree as an empty status", () => {
		expect(collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": "" }))).toBe(block({ ...snapshot, status: "" }));
	});

	it("drops the block when git status fails or times out, rather than claiming a clean tree", () => {
		const noStatus = { ...base };
		delete (noStatus as Record<string, string>)["status --porcelain"];
		expect(collectGitStatus("/x", fakeRunner(noStatus))).toBeNull();
	});

	it("clips a long status at 2,000 characters with the profile's note naming the shell tool", () => {
		const lines = Array.from({ length: 5000 }, (_, i) => `?? generated/file-${i}.txt`);
		const status = lines.join("\n");
		const clipped = (shellTool: string) => `${status.substring(0, GIT_STATUS_MAX_CHARS)}${context.gitStatusClipped({ maxChars: GIT_STATUS_MAX_CHARS, shellTool })}`;
		expect(collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": status }))).toBe(block({ ...snapshot, status: clipped("bash") }));
		expect(collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": status }), "powershell")).toBe(block({ ...snapshot, status: clipped("powershell") }));
		// At the limit exactly, nothing is cut.
		const exact = "x".repeat(GIT_STATUS_MAX_CHARS);
		expect(collectGitStatus("/x", fakeRunner({ ...base, "status --porcelain": exact }))).toBe(block({ ...snapshot, status: exact }));
	});
});

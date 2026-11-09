/**
 * One Code's first-message context wording (profile/text/context/) where the
 * golden snapshot cannot reach it: the date and its change, the notice that
 * the workspace moved on since the snapshot, a git status refreshed at a
 * compaction or cut at its cap, and the notes for an instruction file left
 * out for size. The golden snapshot pins the blocks every session sends. The
 * token budget block's words (profile/text/context-budget/) are checked here
 * too.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { compactionGitStatus, resumeFactsNotice } from "../../extensions/claude-context/context-facts.ts";
import { clipGitStatus, formatGitStatus } from "../../extensions/lib/context/git-status.ts";
import { context } from "../text/context/index.ts";

describe("One Code's context text", () => {
	it("tells a changed date without asking for an announcement", () => {
		expect(context.dateChanged({ date: "2026-11-07" })).toBe(
			"The date has changed. Today's date is now 2026-11-07. No need to announce the new date — the user's own clock shows it.",
		);
	});

	it("re-heads a git status taken at a compaction, and clips a long one", () => {
		const status = formatGitStatus({ branch: "main", mainBranch: "main", user: "", status: "", commits: "abc Golden" });
		expect(status).toContain("This is the git status at the start of the conversation.");
		expect(compactionGitStatus(status)).toContain("This is the git status at the latest compaction. Note that this status is a snapshot in time");
		expect(clipGitStatus("x".repeat(2500), "powershell")).toMatch(/\n\.\.\. \(truncated because it exceeds 2k characters\. If you need more information, run "git status" using powershell\)$/);
	});

	it("names what changed since the saved snapshot", () => {
		const notice = resumeFactsNotice(new Map([["git", "a"]]), true, { git: "b" } as never);
		if (notice) expect(notice.text).toMatch(/^Since the saved context snapshot, git status changed\. The earlier context block reflects the latest compaction/);
		expect(context.changedSinceSnapshot({ changes: ["memory", "instructions"], atCompaction: false })).toContain(
			"the memory index changed; CLAUDE.md-family instructions changed. The earlier context block reflects the session's start",
		);
	});

	it("says a skipped instruction file is not loaded, with its imports", () => {
		expect(context.skippedInstruction({ tokens: 120000, contextWindow: 200000, imported: ["a.md"] })).toMatch(
			/^This file and the files it imports \(a\.md\) are not loaded: together they are about 120,000 tokens/,
		);
		expect(context.classifierSkippedInstruction({ tokens: 5, contextWindow: 10 })).toContain("Leaving it out grants no permission.");
	});
});

describe("date wording", () => {
	it("states today's date, and a change of date without asking for an announcement", () => {
		const words = requireText("context");
		expect(words.date({ date: "2026-09-26" })).toBe("Today's date is 2026-09-26.");
		expect(words.dateChanged({ date: "2026-09-27" })).toBe("The date has changed. Today's date is now 2026-09-27. No need to announce the new date — the user's own clock shows it.");
	});
});

describe("git snapshot wording", () => {
	const snapshot = { branch: "master", mainBranch: "master", user: "", status: "?? f.txt", commits: "" };

	it("heads the snapshot by when it was taken: the conversation's start or the latest compaction", () => {
		const words = requireText("context");
		expect(words.gitStatus({ snapshot, at: "start" })).toContain("# gitStatus\nThis is the git status at the start of the conversation.");
		expect(words.gitStatus({ snapshot, at: "compaction" })).toContain("This is the git status at the latest compaction.");
		expect(words.email({ email: "a@b.com" })).toContain("# userEmail");
	});
});

describe("context change notice wording", () => {
	it("names each changed category and what the earlier block reflects", () => {
		const { changedSinceSnapshot } = requireText("context");
		expect(changedSinceSnapshot({ changes: ["memory"], atCompaction: false })).toBe(
			"Since the saved context snapshot, the memory index changed. The earlier context block reflects the session's start, not the current workspace. Read the current files or run git status if needed.",
		);
		expect(changedSinceSnapshot({ changes: ["git", "memory", "instructions"], atCompaction: false })).toContain(
			"git status changed; the memory index changed; CLAUDE.md-family instructions changed",
		);
		expect(changedSinceSnapshot({ changes: ["git"], atCompaction: true })).toContain("reflects the latest compaction");
	});
});

describe("token budget wording", () => {
	it("says how many tokens are left", () => {
		expect(requireText("contextBudget").tokensLeft({ left: 14_832_967 })).toBe("14832967 tokens left");
	});
});

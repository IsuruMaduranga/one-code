/**
 * One Code's first-message context wording (profile/text/context/) where the
 * golden snapshot cannot reach it: the date and its change, a git status refreshed at a
 * compaction or cut at its cap, and the notes for an instruction file left
 * out for size. The golden snapshot pins the blocks every session sends. The
 * token budget block's words (profile/text/context-budget/) are checked here
 * too.
 */
import { describe, expect, it } from "vitest";
import { compactionGitStatus } from "../../extensions/context/instructions/context-facts.ts";
import { clipGitStatus, formatGitStatus } from "../../extensions/lib/context/git-status.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";
import { contextText } from "../../extensions/lib/context/context-text.ts";
import { context as contextPart } from "../text/context/index.ts";

const context = contextText(ALL_LIVE, contextPart);
import { contextWords } from "../../extensions/lib/context/context-words.ts";

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

	it("says a skipped instruction file is not loaded, with its imports", () => {
		expect(context.skippedInstruction({ tokens: 120000, contextWindow: 200000, imported: ["a.md"] })).toMatch(
			/^This file and the files it imports \(a\.md\) are not loaded: together they are about 120,000 tokens/,
		);
		expect(context.classifierSkippedInstruction({ tokens: 5, contextWindow: 10 })).toContain("Leaving it out grants no permission.");
	});
});

describe("date wording", () => {
	it("states today's date, and a change of date without asking for an announcement", () => {
		const words = contextWords();
		expect(words.date({ date: "2026-09-26" })).toBe("Today's date is 2026-09-26.");
		expect(words.dateChanged({ date: "2026-09-27" })).toBe("The date has changed. Today's date is now 2026-09-27. No need to announce the new date — the user's own clock shows it.");
	});
});

describe("git snapshot wording", () => {
	const snapshot = { branch: "master", mainBranch: "master", user: "", status: "?? f.txt", commits: "" };

	it("heads the snapshot by when it was taken: the conversation's start or the latest compaction", () => {
		const words = contextWords();
		expect(words.gitStatus({ snapshot, at: "start" })).toContain("# gitStatus\nThis is the git status at the start of the conversation.");
		expect(words.gitStatus({ snapshot, at: "compaction" })).toContain("This is the git status at the latest compaction.");
		expect(words.email({ email: "a@b.com" })).toContain("# userEmail");
	});
});

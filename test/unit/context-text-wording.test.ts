/**
 * The notice that the workspace moved on since the saved context snapshot.
 * When the base sends it: context-facts.test.ts.
 */
import { describe, expect, it } from "vitest";
import { FACT_KEYS, resumeFactsNotice } from "../../extensions/context/instructions/context-facts.ts";
import { contextWords } from "../../extensions/lib/context/context-words.ts";

describe("context change notice wording", () => {
	it("opens the notice with what changed and when the earlier block was taken", () => {
		const notice = resumeFactsNotice(new Map([[FACT_KEYS.git, "a"]]), true, { git: "b" } as never);
		expect(notice?.text).toMatch(/^Since the saved context snapshot, git status changed\. The earlier context block reflects the latest compaction/);
	});

	it("names each changed category and what the earlier block reflects", () => {
		const { changedSinceSnapshot } = contextWords();
		expect(changedSinceSnapshot({ changes: ["memory"], atCompaction: false, file: "CLAUDE.md" })).toBe(
			"Since the saved context snapshot, the memory index changed. The earlier context block reflects the session's start, not the current workspace. Read the current files or run git status if needed.",
		);
		expect(changedSinceSnapshot({ changes: ["git", "memory", "instructions"], atCompaction: false, file: "CLAUDE.md" })).toContain(
			"git status changed; the memory index changed; CLAUDE.md-family instructions changed",
		);
		expect(changedSinceSnapshot({ changes: ["git"], atCompaction: true, file: "CLAUDE.md" })).toContain("reflects the latest compaction");
	});
});


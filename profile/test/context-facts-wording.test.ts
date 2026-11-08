/** One Code's notice when the workspace changed since the saved context snapshot. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

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

/**
 * One Code's refusal of an edit to a file the model has not read: what it
 * says counts as a read and what does not. The base gives this refusal for an
 * unread file and after a partial shell read (test/unit/file-tracker.test.ts,
 * test/unit/file-tracker-shell-reads.test.ts).
 */
import { describe, expect, it } from "vitest";
import { fileTracker } from "../text/file-tracker/index.ts";

describe("the unread refusal", () => {
	it("tells the model a cut-off shell output does not count as a read", () => {
		const text = fileTracker.unread({ path: "/p/a.ts", tool: "edit" });
		expect(text).toContain("a plain `cat`");
		expect(text).toContain("output cut off at the size limit");
		// A committed version printed by git is not the file on disk.
		expect(text).toContain("git show HEAD:<file>");
	});

	it("says a shell read counts only when it printed the whole file", () => {
		expect(fileTracker.unread({ path: "/p/big.py", tool: "edit" })).toContain("A shell read counts only when it printed the whole file as it is on disk");
	});
});

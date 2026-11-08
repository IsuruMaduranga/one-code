/**
 * One Code's words for the files put back after a compaction: Claude Code's
 * read call and result, and its note for a file too large to put back. Which
 * files the base puts back: test/unit/file-tracker-restore.test.ts.
 */
import { describe, expect, it } from "vitest";
import { fileTracker } from "../text/file-tracker/index.ts";

describe("One Code's restore texts", () => {
	it("words a restored file as Claude Code's read call and result, and a large one as a note", () => {
		expect(fileTracker.tooLargeToRestore({ path: "/w/big.txt" })).toBe(
			"Note: /w/big.txt was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.",
		);
		expect(fileTracker.restoredCall({ path: "/w/small.txt" })).toBe('Called the read tool with the following input: {"path":"/w/small.txt"}');
		expect(fileTracker.restoredResult({ text: "one\ntwo" })).toBe("Result of calling the read tool:\none\ntwo");
	});
});

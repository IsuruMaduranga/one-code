/** The note left in place of a tool result cleared to fit the compaction request. */
import { describe, expect, it } from "vitest";
import { compactionResultText } from "../../extensions/context/compaction/text.ts";

describe("the cleared-result note", () => {
	it("says how much of a cleared result was left out, images included, and points at the session transcript", () => {
		const { clearedResult } = compactionResultText;
		expect(clearedResult({ omittedChars: 120, images: 0 })).toBe(
			"[Tool result cleared to fit the compaction request: 120 more characters omitted. The full result is in the session transcript.]",
		);
		expect(clearedResult({ omittedChars: 77_952, images: 0 })).toContain("77952 more characters omitted");
		expect(clearedResult({ omittedChars: 5, images: 2 })).toContain("5 more characters and 2 images omitted");
		expect(clearedResult({ omittedChars: 5, images: 1 })).toContain("5 more characters and 1 image omitted");
		expect(clearedResult({ omittedChars: 0, images: 1 })).toContain("and 1 image omitted");
	});
});

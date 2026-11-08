/** One Code's note on a tool result cleared to fit the compaction request. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("cleared result wording", () => {
	it("counts what was omitted and points at the session transcript", () => {
		const { clearedResult } = requireText("compaction");
		const text = clearedResult({ omittedChars: 77_952, images: 0 });
		expect(text).toContain("77952 more characters omitted");
		expect(text).toContain("session transcript");
		expect(text).toContain("cleared to fit the compaction request");
		expect(clearedResult({ omittedChars: 0, images: 1 })).toContain("and 1 image omitted");
	});
});

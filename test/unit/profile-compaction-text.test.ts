/**
 * One Code's compaction wording (profile/text/compaction/) where the golden
 * snapshot cannot reach it: a kept tail that opens on a tool result or a
 * bare tool call, and a tool result cleared to fit a standalone request. The
 * golden snapshot pins the manual and overflow requests and the stored summary.
 */
import { describe, expect, it } from "vitest";
import { compaction, keptTailNote } from "../../profile/text/compaction/index.ts";

describe("One Code's compaction text", () => {
	it("names each kind of first kept message", () => {
		expect(keptTailNote({ count: 1, landmark: { kind: "toolResult", tool: "bash" } })).toContain("the final 1 message, beginning with the result of the bash call, stay");
		expect(keptTailNote({ count: 2, landmark: { kind: "calls", tool: "read", hint: "src/x.ts" } })).toContain("beginning with the assistant message that calls read (src/x.ts), stay");
		expect(keptTailNote({ count: 2, landmark: { kind: "calls", tool: "todo" } })).toContain("beginning with the assistant message that calls todo, stay");
		expect(keptTailNote({ count: 3 })).toContain("the final 3 messages, stay in context verbatim");
	});

	it("says how much of a cleared result was left out, images included", () => {
		expect(compaction.clearedResult({ omittedChars: 120, images: 0 })).toBe(
			"[Tool result cleared to fit the compaction request: 120 more characters omitted. The full result is in the session transcript.]",
		);
		expect(compaction.clearedResult({ omittedChars: 5, images: 2 })).toContain("5 more characters and 2 images omitted");
		expect(compaction.clearedResult({ omittedChars: 5, images: 1 })).toContain("5 more characters and 1 image omitted");
	});
});

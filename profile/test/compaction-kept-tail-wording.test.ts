/**
 * One Code's compaction instruction with a kept tail: the note that scopes the
 * summary to the discarded part, inside the same system-reminder.
 */
import { describe, expect, it } from "vitest";
import { buildCompactionInstruction, keptTailNote } from "../text/compaction/index.ts";

describe("buildCompactionInstruction with a kept tail", () => {
	it("scopes the summary to the discarded part inside the same system-reminder", () => {
		const text = buildCompactionInstruction({ reason: "threshold", keptTail: { count: 7, landmark: { kind: "opens", text: "Run the tests" } } });
		expect(text).toContain(keptTailNote({ count: 7, landmark: { kind: "opens", text: "Run the tests" } }));
		expect(text).toContain('the final 7 messages, beginning with the message that opens "Run the tests", stay in context verbatim');
		expect(text.indexOf("stay in context verbatim")).toBeLessThan(text.indexOf("CRITICAL: Respond"));
		expect(text.match(/<system-reminder>/g)).toHaveLength(1);
	});

	it("says nothing about a tail when there is none (the reconstruction path, or a cut at the very end)", () => {
		expect(buildCompactionInstruction({ reason: "manual", keptTail: { count: 0 } })).toBe(buildCompactionInstruction({ reason: "manual" }));
		expect(buildCompactionInstruction({ reason: "manual", keptTail: undefined })).not.toContain("stay in context verbatim");
	});

	it("uses the singular for one kept message", () => {
		expect(keptTailNote({ count: 1 })).toContain("the final 1 message, stay");
	});
});

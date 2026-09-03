import { describe, expect, it } from "vitest";
import { keptTailOf } from "../../extensions/compaction/index.ts";
import { buildCompactionInstruction, keptTailNote } from "../../extensions/compaction/prompt.ts";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text = "…") => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (text = "ran") => ({ role: "toolResult", content: [{ type: "text", text }] });

describe("keptTailOf (C6)", () => {
	it("counts the messages after pi's cut point and quotes how the first kept one opens", () => {
		const captured = [user("first"), assistant(), toolResult(), assistant(), user("Now fix the flaky test in auth.spec.ts please"), assistant()];
		const tail = keptTailOf(captured, {
			messagesToSummarize: captured.slice(0, 4) as never,
			turnPrefixMessages: [],
			isSplitTurn: false,
			previousSummary: undefined,
		});
		expect(tail).toEqual({ count: 2, opening: "Now fix the flaky test in auth.spec.ts please" });
	});

	it("accounts for the leading compaction summary and a split turn's prefix", () => {
		const captured = [{ role: "compactionSummary", summary: "old" }, user("a"), assistant(), toolResult(), assistant(), toolResult("late"), assistant()];
		const tail = keptTailOf(captured, {
			messagesToSummarize: [captured[1], captured[2]] as never,
			turnPrefixMessages: [captured[3], captured[4]] as never,
			isSplitTurn: true,
			previousSummary: "old",
		});
		expect(tail).toEqual({ count: 2, opening: "late" });
	});

	it("makes no claim when the captured request does not align with the doomed span", () => {
		const captured = [user("a"), assistant(), user("b"), assistant()];
		expect(
			keptTailOf(captured, { messagesToSummarize: [assistant(), user("x")] as never, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }),
		).toBeUndefined();
		expect(
			keptTailOf(captured, { messagesToSummarize: [] as never, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }),
		).toBeUndefined();
	});

	it("shortens a long opening to a single 80-character line", () => {
		const long = `${"word ".repeat(40)}\nsecond line`;
		const captured = [user("a"), assistant(), user(long)];
		const tail = keptTailOf(captured, { messagesToSummarize: captured.slice(0, 2) as never, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined });
		expect(tail?.count).toBe(1);
		expect(tail?.opening).toHaveLength(81);
		expect(tail?.opening?.endsWith("…")).toBe(true);
		expect(tail?.opening).not.toContain("\n");
	});
});

describe("buildCompactionInstruction with a kept tail", () => {
	it("scopes the summary to the discarded part inside the same system-reminder", () => {
		const text = buildCompactionInstruction({ reason: "threshold", keptTail: { count: 7, opening: "Run the tests" } });
		expect(text).toContain(keptTailNote({ count: 7, opening: "Run the tests" }));
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

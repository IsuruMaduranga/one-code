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
		expect(tail).toEqual({ count: 2, landmark: 'the message that opens "Now fix the flaky test in auth.spec.ts please"' });
	});

	it("accounts for the leading compaction summary and a split turn's prefix", () => {
		const captured = [{ role: "compactionSummary", summary: "old" }, user("a"), assistant(), toolResult(), assistant(), toolResult("late"), assistant()];
		const tail = keptTailOf(captured, {
			messagesToSummarize: [captured[1], captured[2]] as never,
			turnPrefixMessages: [captured[3], captured[4]] as never,
			isSplitTurn: true,
			previousSummary: "old",
		});
		expect(tail).toEqual({ count: 2, landmark: 'the message that opens "late"' });
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

	it("makes no claim on Google when a kept tool result carries an image", () => {
		const image = { role: "toolResult", toolName: "read", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] };
		const captured = [user("a"), assistant(), assistant(), image, user("b")];
		const prep = { messagesToSummarize: captured.slice(0, 2) as never, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined };
		expect(keptTailOf(captured, prep, "google-generative-ai")).toBeUndefined();
		// Anthropic keeps an image inside its tool result: the count stands.
		expect(keptTailOf(captured, prep, "anthropic-messages")?.count).toBe(3);
	});

	it("shortens a long opening to a single 80-character line", () => {
		const long = `${"word ".repeat(40)}\nsecond line`;
		const captured = [user("a"), assistant(), user(long)];
		const tail = keptTailOf(captured, { messagesToSummarize: captured.slice(0, 2) as never, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined });
		expect(tail?.count).toBe(1);
		const quoted = tail?.landmark?.match(/^the message that opens "(.*)"$/)?.[1];
		expect(quoted).toHaveLength(81);
		expect(quoted?.endsWith("…")).toBe(true);
		expect(quoted).not.toContain("\n");
	});

	it("counts a parallel batch's results as one message where the provider merges them", () => {
		const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: name, name, arguments: args });
		const calls = (...blocks: unknown[]) => ({ role: "assistant", content: blocks });
		const result = (toolName: string) => ({ role: "toolResult", toolName, content: [{ type: "text", text: "ok" }] });
		const doomed = [user("go"), calls(call("read", { path: "a" }), call("read", { path: "b" }), call("read", { path: "c" })), result("read"), result("read"), result("read")];
		const kept = [calls(call("read", { path: "src/x.ts" }), call("grep", { pattern: "foo" })), result("read"), result("grep"), assistant("done")];
		const captured = [...doomed, ...kept];
		const preparation = { messagesToSummarize: doomed as never, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined };
		// Anthropic sends the two kept results as one user message: three messages stay.
		expect(keptTailOf(captured, preparation, "anthropic-messages")).toEqual({
			count: 3,
			landmark: "the assistant message that calls read (src/x.ts)",
		});
		// Chat Completions sends one message per result.
		expect(keptTailOf(captured, preparation, "openai-completions")?.count).toBe(4);
		// A kept tail that opens on a result names the call it answers.
		const fromResult = keptTailOf([...doomed.slice(0, 2), ...doomed.slice(2)], {
			...preparation,
			messagesToSummarize: doomed.slice(0, 2) as never,
		}, "anthropic-messages");
		expect(fromResult).toEqual({ count: 1, landmark: "the result of the read call" });
	});
});

describe("buildCompactionInstruction with a kept tail", () => {
	it("scopes the summary to the discarded part inside the same system-reminder", () => {
		const text = buildCompactionInstruction({ reason: "threshold", keptTail: { count: 7, landmark: 'the message that opens "Run the tests"' } });
		expect(text).toContain(keptTailNote({ count: 7, landmark: 'the message that opens "Run the tests"' }));
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

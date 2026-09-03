import { describe, expect, it } from "vitest";
import { tokensLeft, totalTokensBlock } from "../../extensions/context-budget/budget.ts";
import { ReminderQueue, appendReminderBlocks } from "../../extensions/lib/reminders.ts";

describe("tokensLeft", () => {
	it("is the window minus the tokens in use, floored at zero", () => {
		expect(tokensLeft({ tokens: 12_345, contextWindow: 200_000 })).toBe(187_655);
		expect(tokensLeft({ tokens: 250_000, contextWindow: 200_000 })).toBe(0);
	});

	it("is undefined when the usage is unknown or incomplete", () => {
		expect(tokensLeft(undefined)).toBeUndefined();
		expect(tokensLeft({ tokens: null, contextWindow: 200_000 })).toBeUndefined();
		expect(tokensLeft({ tokens: 10, contextWindow: 0 })).toBeUndefined();
		expect(tokensLeft({ tokens: Number.NaN, contextWindow: 10 })).toBeUndefined();
	});
});

describe("totalTokensBlock", () => {
	it("is Claude Code's bare block, byte for byte", () => {
		expect(totalTokensBlock(14_832_967)).toBe("<total_tokens>14832967 tokens left</total_tokens>");
	});

	it("rides a tool result unframed when queued as a raw one-shot", () => {
		const q = new ReminderQueue();
		q.enqueue(totalTokensBlock(100), { placement: "last-append", raw: true });
		const content = appendReminderBlocks([{ type: "text", text: "ok" }], q.takeOneShots());
		expect(content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "text", text: "<total_tokens>100 tokens left</total_tokens>" },
		]);
	});
});

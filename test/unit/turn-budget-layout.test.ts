import { describe, expect, it } from "vitest";
import { wrapReminder } from "../../extensions/lib/reminders.ts";
import { CLEAR_AT_NUDGE, resolveCountdowns, withTurnBudgetMessages } from "../../extensions/lib/turn-budget-layout.ts";

const BUDGET = "<total_tokens>15000000 tokens left</total_tokens>";
const left = (n: number) => `<total_tokens>${n} tokens left</total_tokens>`;
const mark = { type: "ephemeral" };

describe("resolveCountdowns", () => {
	const stored = () => [
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		// A read of a file that itself holds the line: the output must stay whole.
		{ role: "toolResult", toolCallId: "a", content: [{ type: "text", text: `line 1\n${left(1)}\nline 3` }, { type: "text", text: left(14_990_000) }] },
	];

	it("lifts the countdown block by call id on a system-role model, leaving the tool's own output whole", () => {
		const { messages, left: countdowns } = resolveCountdowns(stored(), true);
		expect(messages[1].content).toEqual([{ type: "text", text: `line 1\n${left(1)}\nline 3` }]);
		expect(countdowns).toEqual(new Map([["a", 14_990_000]]));
	});

	it("frames it a blank line after the output elsewhere, once pi joins the blocks with a newline", () => {
		const { messages, left: countdowns } = resolveCountdowns(stored(), false);
		expect(messages[1].content).toEqual([{ type: "text", text: `line 1\n${left(1)}\nline 3` }, { type: "text", text: `\n${wrapReminder(left(14_990_000))}` }]);
		expect(countdowns.size).toBe(0);
	});

	it("returns the same array when no result carries a countdown", () => {
		const messages = [{ role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "x" }] }];
		expect(resolveCountdowns(messages, true).messages).toBe(messages);
	});
});

/** An Anthropic body after resolveCountdowns: a tool round, a later prompt, a second, parallel tool round. */
function anthropicBody() {
	return {
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "a" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "out-a" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: BUDGET }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "b" }, { type: "tool_use", id: "c" }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "b", content: "out-b" },
					{ type: "tool_result", tool_use_id: "c", content: "out-c", cache_control: mark },
				],
			},
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
}
const countdowns = new Map([
	["a", 14_990_000],
	["b", 14_980_000],
	["c", 14_970_000],
]);

describe("withTurnBudgetMessages on a model that takes system messages", () => {
	const run = (nudge = false) =>
		(withTurnBudgetMessages(anthropicBody(), { shape: "anthropic", systemRole: true, role: "system", left: countdowns, nudge }) as { messages: Array<Record<string, unknown>> }).messages;

	it("follows later prompts and tool-result messages with a system message, the batch's lowest countdown once", () => {
		const messages = run();
		expect(messages[3]).toEqual({ role: "system", content: [{ type: "text", text: left(14_990_000) }] });
		expect(messages[5]).toEqual({ role: "user", content: [{ type: "text", text: "second" }] });
		expect(messages[6]).toEqual({ role: "system", content: [{ type: "text", text: BUDGET }] });
		// The mark moves from the result onto the message that now ends the request.
		expect((messages[8].content as Array<Record<string, unknown>>)[1]).toEqual({ type: "tool_result", tool_use_id: "c", content: "out-c" });
		expect(messages[9]).toEqual({ role: "system", content: [{ type: "text", text: left(14_970_000), cache_control: mark }] });
		expect(messages.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
	});

	it("adds Fable's clear_at nudge after each tool result's message, the mark staying on the budget line", () => {
		const messages = run(true);
		expect(messages[4]).toEqual({ role: "system", content: CLEAR_AT_NUDGE, clear_at: "next_user_message" });
		const last = messages.findLastIndex((m) => m.clear_at !== undefined);
		expect((messages[last - 1].content as Array<Record<string, unknown>>)[0].cache_control).toEqual(mark);
	});

	it("follows a run of OpenAI tool outputs with one message in the API's role, matching pi's Responses call ids", () => {
		const input = [
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ type: "function_call_output", call_id: "a", output: "x" },
			{ type: "function_call_output", call_id: "b", output: "y" },
		];
		const out = withTurnBudgetMessages({ input }, { shape: "responses", systemRole: true, role: "developer", left: new Map([["a|item1", 9], ["b|item2", 7]]) }) as { input: unknown[] };
		expect(out.input.slice(1)).toEqual([...input.slice(1), { role: "developer", content: left(7) }]);
	});
});

describe("withTurnBudgetMessages elsewhere (Claude Code's Haiku shape)", () => {
	it("frames the line before a later prompt's text, and leaves tool results to resolveCountdowns", () => {
		const out = withTurnBudgetMessages(anthropicBody(), { shape: "anthropic", systemRole: false, role: "system", left: new Map() }) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toHaveLength(8);
		expect(out.messages[4].content).toEqual([{ type: "text", text: `${wrapReminder(BUDGET)}\n` }, { type: "text", text: "second" }]);
		expect(out.messages[2]).toEqual(anthropicBody().messages[2]);
	});

	it("leaves a body with no marker alone", () => {
		expect(withTurnBudgetMessages({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, { shape: "anthropic", systemRole: true, role: "system", left: new Map() })).toBeUndefined();
	});
});

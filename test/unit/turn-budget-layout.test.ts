import { describe, expect, it } from "vitest";
import { CLEAR_AT_NUDGE, framedTotalTokens, withTurnBudgetMessages } from "../../extensions/lib/turn-budget-layout.ts";

const BUDGET = "<total_tokens>15000000 tokens left</total_tokens>";
const left = (n: number) => `<total_tokens>${n} tokens left</total_tokens>`;
const mark = { type: "ephemeral" };

/** An Anthropic body: the first prompt (the stack's carrier), a tool round, a later prompt, a second tool round. */
function anthropicBody() {
	return {
		messages: [
			{ role: "user", content: [{ type: "text", text: framedTotalTokens(BUDGET) }, { type: "text", text: "first" }, { type: "text", text: BUDGET }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "a" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: `out-a\n${left(14_990_000)}` }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: BUDGET }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "b" }, { type: "tool_use", id: "c" }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "b", content: `out-b\n${left(14_980_000)}\n<system-reminder>\nnote\n</system-reminder>` },
					{ type: "tool_result", tool_use_id: "c", content: `out-c\n${left(14_970_000)}`, cache_control: mark },
				],
			},
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
}

describe("withTurnBudgetMessages on a model that takes system messages", () => {
	const run = (nudge = false) =>
		(withTurnBudgetMessages(anthropicBody(), { shape: "anthropic", systemRole: true, role: "system", carrier: 0, nudge }) as { messages: Array<Record<string, unknown>> }).messages;

	it("drops the first prompt's marker and follows later prompts and tool results with a system message", () => {
		const messages = run();
		expect(messages[0].content).toEqual([{ type: "text", text: framedTotalTokens(BUDGET) }, { type: "text", text: "first" }]);
		expect(messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "out-a" }] });
		expect(messages[3]).toEqual({ role: "system", content: [{ type: "text", text: left(14_990_000) }] });
		expect(messages[5]).toEqual({ role: "user", content: [{ type: "text", text: "second" }] });
		expect(messages[6]).toEqual({ role: "system", content: [{ type: "text", text: BUDGET }] });
		// The batch's lowest countdown, once; a reminder after the countdown stays.
		expect((messages[8].content as Array<{ content: string }>)[0].content).toBe("out-b\n<system-reminder>\nnote\n</system-reminder>");
		expect(messages[9]).toEqual({ role: "system", content: [{ type: "text", text: left(14_970_000), cache_control: mark }] });
		expect((messages[8].content as Array<Record<string, unknown>>)[1]).toEqual({ type: "tool_result", tool_use_id: "c", content: "out-c" });
		expect(messages.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
	});

	it("adds Fable's clear_at nudge after each tool result's message, without a cache mark", () => {
		const messages = run(true);
		expect(messages[4]).toEqual({ role: "system", content: CLEAR_AT_NUDGE, clear_at: "next_user_message" });
		const last = messages.findLastIndex((m) => m.clear_at !== undefined);
		expect((messages[last - 1].content as Array<Record<string, unknown>>)[0].cache_control).toEqual(mark);
	});

	it("treats every prompt as a later one when the stack's carrier is not in the request (a fork's tail)", () => {
		const out = withTurnBudgetMessages(anthropicBody(), { shape: "anthropic", systemRole: true, role: "system" }) as { messages: Array<Record<string, unknown>> };
		expect(out.messages[1]).toEqual({ role: "system", content: [{ type: "text", text: BUDGET }] });
	});

	it("follows a run of OpenAI tool outputs with one message in the API's role", () => {
		const input = [
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ type: "function_call_output", call_id: "a", output: `x\n${left(9)}` },
			{ type: "function_call_output", call_id: "b", output: `y\n${left(7)}` },
		];
		const out = withTurnBudgetMessages({ input }, { shape: "responses", systemRole: true, role: "developer", carrier: 0 }) as { input: unknown[] };
		expect(out.input.slice(1)).toEqual([
			{ type: "function_call_output", call_id: "a", output: "x" },
			{ type: "function_call_output", call_id: "b", output: "y" },
			{ role: "developer", content: left(7) },
		]);
	});
});

describe("withTurnBudgetMessages elsewhere (Claude Code's Haiku shape)", () => {
	it("frames the line before later prompts and a blank line after tool output", () => {
		const out = withTurnBudgetMessages(anthropicBody(), { shape: "anthropic", systemRole: false, role: "system", carrier: 0 }) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toHaveLength(8);
		expect(out.messages[0].content).toEqual([{ type: "text", text: framedTotalTokens(BUDGET) }, { type: "text", text: "first" }]);
		expect((out.messages[2].content as Array<{ content: string }>)[0].content).toBe(`out-a\n\n${framedTotalTokens(left(14_990_000))}`);
		expect(out.messages[4].content).toEqual([{ type: "text", text: `${framedTotalTokens(BUDGET)}\n` }, { type: "text", text: "second" }]);
	});

	it("rewrites Chat Completions tool messages and leaves a body without lines alone", () => {
		const messages = [{ role: "tool", tool_call_id: "a", content: `x\n${left(5)}` }];
		const out = withTurnBudgetMessages({ messages }, { shape: "completions", systemRole: false, role: "system" }) as { messages: unknown[] };
		expect(out.messages).toEqual([{ role: "tool", tool_call_id: "a", content: `x\n\n${framedTotalTokens(left(5))}` }]);
		expect(withTurnBudgetMessages({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, { shape: "anthropic", systemRole: true, role: "system" })).toBeUndefined();
	});
});

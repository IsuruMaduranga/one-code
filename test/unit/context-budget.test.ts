import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TURN_TOKEN_BUDGET,
	totalTokensBlock,
	TurnBudget,
	turnTokenBudget,
} from "../../extensions/context-budget/budget.ts";
import contextBudgetExtension from "../../extensions/context-budget/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("turnTokenBudget", () => {
	it("is Claude Code's 15,000,000 unless CC_TOTAL_TOKENS_BUDGET names a positive number", () => {
		expect(turnTokenBudget({})).toBe(DEFAULT_TURN_TOKEN_BUDGET);
		expect(DEFAULT_TURN_TOKEN_BUDGET).toBe(15_000_000);
		expect(turnTokenBudget({ CC_TOTAL_TOKENS_BUDGET: "2000000" })).toBe(2_000_000);
		expect(turnTokenBudget({ CC_TOTAL_TOKENS_BUDGET: "0" })).toBe(DEFAULT_TURN_TOKEN_BUDGET);
		expect(turnTokenBudget({ CC_TOTAL_TOKENS_BUDGET: "lots" })).toBe(DEFAULT_TURN_TOKEN_BUDGET);
		expect(turnTokenBudget({ CC_TOTAL_TOKENS_BUDGET: " " })).toBe(DEFAULT_TURN_TOKEN_BUDGET);
	});
});

describe("TurnBudget", () => {
	it("counts down by the context's growth since the turn started, never up", () => {
		const budget = new TurnBudget(1000);
		budget.startTurn(500);
		expect(budget.left(500)).toBe(1000);
		expect(budget.left(650)).toBe(850);
		// pi's estimate can dip (a compaction mid-turn); the countdown holds.
		expect(budget.left(600)).toBe(850);
		expect(budget.left(700)).toBe(800);
	});

	it("resets on the next turn", () => {
		const budget = new TurnBudget(1000);
		budget.startTurn(500);
		budget.left(900);
		budget.startTurn(900);
		expect(budget.left(900)).toBe(1000);
	});

	it("takes the first known size as the baseline when the turn started without one, and repeats the last value on an unknown size", () => {
		const budget = new TurnBudget(1000);
		budget.startTurn(undefined);
		expect(budget.left(undefined)).toBe(1000);
		expect(budget.left(300)).toBe(1000);
		expect(budget.left(340)).toBe(960);
		expect(budget.left(null)).toBe(960);
	});

	it("rebases at a compaction: what the turn spent stays spent, and growth after it counts on top", () => {
		const budget = new TurnBudget(1000);
		budget.startTurn(500);
		expect(budget.left(800)).toBe(700);
		budget.rebase(200);
		expect(budget.left(200)).toBe(700);
		expect(budget.left(260)).toBe(640);
		// An unknown size at the compaction: the first known size is the new baseline.
		budget.rebase(undefined);
		expect(budget.left(undefined)).toBe(640);
		expect(budget.left(100)).toBe(640);
		expect(budget.left(150)).toBe(590);
	});

	it("floors at zero", () => {
		const budget = new TurnBudget(100);
		budget.startTurn(0);
		expect(budget.left(250)).toBe(0);
	});
});

describe("totalTokensBlock", () => {
	it("is Claude Code's bare block, byte for byte", () => {
		expect(totalTokensBlock(14_832_967)).toBe("<total_tokens>14832967 tokens left</total_tokens>");
	});
});

describe("context-budget wiring", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const usage = (tokens: number | undefined) => ({ getContextUsage: () => (tokens === undefined ? undefined : { tokens, contextWindow: 1_000_000, percent: 0 }) });
	const collect = () => {
		const fake = createFakePi();
		const reminders: Array<Record<string, unknown>> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as Record<string, unknown>));
		contextBudgetExtension(fake.pi as never);
		return { fake, reminders };
	};

	it("puts the constant budget in the context stack and on every user message as a raw sticky block anchored at the session's start", async () => {
		const { fake, reminders } = collect();
		await fake.fireOne("session_start", {}, createFakeCtx());
		expect(reminders).toEqual([
			{
				text: "<total_tokens>15000000 tokens left</total_tokens>",
				key: "total-tokens-first",
				placement: "first-prepend",
				order: 46,
			},
			{
				text: "<total_tokens>15000000 tokens left</total_tokens>",
				key: "total-tokens",
				placement: "sticky-append",
				raw: true,
				since: 0,
				skipStackCarrier: true,
			},
		]);
	});

	it("counts a turn down on its tool results from the context size at the turn's first run, and resets on the next turn", async () => {
		const { fake, reminders } = collect();
		// Turn 1 opens at 10,000 tokens of context; two tool rounds grow it.
		await fake.fireOne("agent_start", {}, createFakeCtx(usage(10_000)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(12_500)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(13_200)));
		// A retry run inside the same turn is not a new turn.
		await fake.fireOne("agent_start", {}, createFakeCtx(usage(13_200)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(14_000)));
		await fake.fireOne("agent_settled", {}, createFakeCtx());
		// Turn 2 (a prompt or a harness notification alike) starts from 15,000,000 again.
		await fake.fireOne("agent_start", {}, createFakeCtx(usage(14_500)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(14_600)));

		const texts = reminders.map((r) => r.text);
		expect(texts).toEqual([
			"<total_tokens>14997500 tokens left</total_tokens>",
			"<total_tokens>14996800 tokens left</total_tokens>",
			"<total_tokens>14996000 tokens left</total_tokens>",
			"<total_tokens>14999900 tokens left</total_tokens>",
		]);
		for (const r of reminders) expect(r).toMatchObject({ placement: "last-append", raw: true });
	});

	it("keeps counting down after a compaction inside the turn, from what the turn had spent", async () => {
		const { fake, reminders } = collect();
		await fake.fireOne("agent_start", {}, createFakeCtx(usage(10_000)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(50_000)));
		// The compaction drops the context; pi knows no size until the next reply.
		await fake.fireOne("session_compact", {}, createFakeCtx({ getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000, percent: null }) }));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(undefined)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(8_000)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(9_500)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(12_000)));

		expect(reminders.map((r) => r.text)).toEqual([
			"<total_tokens>14960000 tokens left</total_tokens>",
			"<total_tokens>14960000 tokens left</total_tokens>",
			// The first size after the compaction is the new baseline.
			"<total_tokens>14960000 tokens left</total_tokens>",
			"<total_tokens>14958500 tokens left</total_tokens>",
			"<total_tokens>14956000 tokens left</total_tokens>",
		]);
	});

	it("gives each of several parallel tool results its own single countdown, unframed", async () => {
		// pi finalizes a parallel batch concurrently, so the results' tool_result
		// handler chains interleave; each countdown is bound to its own call.
		const fake = createFakePi();
		contextBudgetExtension(fake.pi as never);
		systemReminderExtension(fake.pi as never);
		const session = (tokens?: number) => createFakeCtx({ ...usage(tokens), sessionManager: { getSessionId: () => "s", getBranch: () => fake.branch } });
		await fake.fire("session_start", {}, session());
		await fake.fireOne("agent_start", {}, session(10_000));
		const result = (toolCallId: string, tokens: number) =>
			fake.fire("tool_result", { toolCallId, content: [{ type: "text", text: `ran ${toolCallId}` }] }, session(tokens));
		await Promise.all([result("call-a", 10_100), result("call-b", 10_200)]);
		// The next request places each on its own result (system-reminder renders the pending entries).
		const results = ["call-a", "call-b"].map((toolCallId) => ({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: `ran ${toolCallId}` }], timestamp: 1 }));
		const [rendered] = await fake.fire<{ messages: Array<{ content: Array<{ text: string }> }> }>("context", { messages: [{ role: "user", content: "go", timestamp: 0 }, ...results] }, session());
		expect(rendered.messages[1].content.map((c) => c.text)).toEqual(["ran call-a", "<total_tokens>14999900 tokens left</total_tokens>"]);
		expect(rendered.messages[2].content.map((c) => c.text)).toEqual(["ran call-b", "<total_tokens>14999800 tokens left</total_tokens>"]);
	});

	it("is off entirely under CC_TOTAL_TOKENS=0", async () => {
		vi.stubEnv("CC_TOTAL_TOKENS", "0");
		const { fake, reminders } = collect();
		await fake.fireOne("session_start", {}, createFakeCtx());
		await fake.fireOne("agent_start", {}, createFakeCtx(usage(10)));
		await fake.fireOne("tool_result", {}, createFakeCtx(usage(20)));
		expect(reminders).toEqual([]);
	});
});

/** Regressions for the request-shaping steps: the cache mark, call ids after a model switch, and fallbacks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { deferredAddendumText } from "../../extensions/lib/deferred.ts";
import { wrapReminder } from "../../extensions/lib/reminders.ts";
import { subagentHandbackExtension, SUBAGENT_HANDBACK_LOAD_FIRST } from "../../extensions/lib/subagent-handback.ts";
import { TOOLS_AVAILABLE, withToolAdditions } from "../../extensions/lib/tool-additions.ts";
import { withTurnBudgetMessages } from "../../extensions/lib/turn-budget-layout.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const BUDGET = "<total_tokens>15000000 tokens left</total_tokens>";
const mark = { type: "ephemeral", ttl: "1h" };
/** The first exchange: the first prompt carries the context stack, never a marker. */
const opening = [
	{ role: "user", content: [{ type: "text", text: "first" }] },
	{ role: "assistant", content: [{ type: "text", text: "ok" }] },
];
const prompt = () => ({ messages: [...opening, { role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: BUDGET, cache_control: mark }] }, { role: "system", content: [] }] });

describe("a later prompt's marker carries pi's cache mark", () => {
	it("moves it onto the per-turn system message on a system-role model", () => {
		const out = withTurnBudgetMessages(prompt(), { shape: "anthropic", systemRole: true, role: "system", left: new Map() }) as { messages: unknown[] };
		expect(out.messages).toEqual([
			...opening,
			{ role: "user", content: [{ type: "text", text: "second" }] },
			{ role: "system", content: [{ type: "text", text: BUDGET, cache_control: mark }] },
			{ role: "system", content: [] },
		]);
	});

	it("keeps it on the prompt's last block in Haiku's shape", () => {
		const out = withTurnBudgetMessages(prompt(), { shape: "anthropic", systemRole: false, role: "system", left: new Map() }) as { messages: Array<{ content: unknown[] }> };
		expect(out.messages[2].content).toEqual([{ type: "text", text: `${wrapReminder(BUDGET)}\n` }, { type: "text", text: "second", cache_control: mark }]);
	});

	it("keeps it when a pinned addendum ends the message, and never empties a message", () => {
		const framed = wrapReminder(deferredAddendumText(["late"]));
		const out = withToolAdditions({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: framed, cache_control: mark }] }] }, new Map())!;
		const messages = out.payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
		expect(messages[0].content).toEqual([{ type: "text", text: "hi" }]);
		expect(messages[1].content.at(-1)?.cache_control).toEqual(mark);
		expect(withToolAdditions({ messages: [{ role: "user", content: [{ type: "text", text: framed }] }] }, new Map())).toBeUndefined();
	});
});

describe("call ids pi rewrote after a model switch", () => {
	it("still finds the countdown and the addition of a call made on another provider", () => {
		const id = "call_x|fc_y";
		const wire = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_x_fc_y", content: "ok" }] }] };
		const out = withTurnBudgetMessages(wire, { shape: "anthropic", systemRole: true, role: "system", left: new Map([[id, 7]]) }) as { messages: unknown[] };
		expect(out.messages[1]).toEqual({ role: "system", content: [{ type: "text", text: "<total_tokens>7 tokens left</total_tokens>" }] });
		const added = withToolAdditions(wire, new Map([[id, ["late"]]]))!;
		expect((added.payload.messages as Array<{ content: Array<{ text?: string }> }>)[1].content[0].text).toBe(`${TOOLS_AVAILABLE}\nlate`);
	});

	it("sends the addition as text when the tools cannot be referenced", () => {
		const wire = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] };
		const out = withToolAdditions(wire, new Map([["t", ["late"]]]), false)!;
		expect((out.payload.messages as unknown[])[1]).toEqual({ role: "system", content: [{ type: "text", text: `${TOOLS_AVAILABLE}\nlate` }] });
	});
});

describe("system-reminder resolves stored countdowns on every request", () => {
	it("lifts them even with nothing queued", async () => {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const model = { id: "claude-opus-5-5", api: "anthropic-messages", provider: "anthropic", compat: { supportsMidConvoSystemMessages: true } };
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "ok" }, { type: "text", text: "<total_tokens>9 tokens left</total_tokens>" }], timestamp: 2 },
		];
		const shaped = await fake.fireOne<{ messages: Array<{ content: unknown[] }> }>("context", { messages }, createFakeCtx({ model }));
		expect(shaped?.messages[1].content).toEqual([{ type: "text", text: "ok" }]);
	});
});

describe("text that only looks like a marker stays the user's or the tool's", () => {
	afterEach(() => vi.unstubAllEnvs());
	const stack = { type: "text", text: wrapReminder("# claudeMd\nProject instructions.") };

	// The first prompt carries the context stack and never a marker
	// (context-budget's skipStackCarrier), so its own text is never lifted.
	it.each([
		["a system-role model", true],
		["Haiku's shape", false],
	] as const)("leaves a first prompt that is exactly the line on %s", (_, systemRole) => {
		const body = { messages: [{ role: "user", content: [stack, { type: "text", text: BUDGET }] }] };
		expect(withTurnBudgetMessages(body, { shape: "anthropic", systemRole, role: "system", left: new Map() })).toBeUndefined();
	});

	it("finds the first prompt after an OpenAI system message, and still lifts a later prompt's marker", () => {
		const user = (text: string, marker?: boolean) => ({ role: "user", content: [{ type: "text", text }, ...(marker ? [{ type: "text", text: BUDGET }] : [])] });
		const body = { messages: [{ role: "system", content: "prompt" }, user(BUDGET), { role: "assistant", content: "ok" }, user(BUDGET, true)] };
		const out = withTurnBudgetMessages(body, { shape: "completions", systemRole: true, role: "system", left: new Map() }) as { messages: unknown[] };
		expect(out.messages.slice(0, 4)).toEqual(body.messages.slice(0, 3).concat([user(BUDGET)]));
		expect(out.messages).toHaveLength(5);
	});

	it("leaves a tool result that is exactly the line whole when the budget is off", async () => {
		vi.stubEnv("CC_TOTAL_TOKENS", "0");
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const model = { id: "claude-opus-5-5", api: "anthropic-messages", provider: "anthropic", compat: { supportsMidConvoSystemMessages: true } };
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "<total_tokens>9 tokens left</total_tokens>" }], timestamp: 2 },
		];
		expect(await fake.fireOne("context", { messages }, createFakeCtx({ model }))).toBeUndefined();
	});
});

describe("a fork's hand-back reminder", () => {
	it("names the load step where the tool is deferred", async () => {
		const fake = createFakePi();
		const texts: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => texts.push((data as { text: string }).text));
		subagentHandbackExtension({ recordHandback: () => true }, { deferred: true })(fake.pi as never);
		await fake.fireOne("session_start", {}, createFakeCtx());
		expect(texts[0].startsWith(`${SUBAGENT_HANDBACK_LOAD_FIRST}\n`)).toBe(true);
	});
});

describe("a user's own <total_tokens> text", () => {
	it("stays the user's: the marker is the last match, and with the budget off nothing is taken", () => {
		const body = () => ({ messages: [...opening, { role: "user", content: [{ type: "text", text: BUDGET }, { type: "text", text: BUDGET }] }] });
		const out = withTurnBudgetMessages(body(), { shape: "anthropic", systemRole: true, role: "system", left: new Map() }) as { messages: Array<{ content: unknown[] }> };
		expect(out.messages[2].content).toEqual([{ type: "text", text: BUDGET }]);
		expect(withTurnBudgetMessages({ messages: [...opening, { role: "user", content: [{ type: "text", text: BUDGET }] }] }, { shape: "anthropic", systemRole: true, role: "system", left: new Map(), markers: false })).toBeUndefined();
	});
});

/** Regressions for the request-shaping steps: the cache mark, call ids after a model switch, and fallbacks. */
import { describe, expect, it } from "vitest";
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
const prompt = () => ({ messages: [{ role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: BUDGET, cache_control: mark }] }, { role: "system", content: [] }] });

describe("a later prompt's marker carries pi's cache mark", () => {
	it("moves it onto the per-turn system message on a system-role model", () => {
		const out = withTurnBudgetMessages(prompt(), { shape: "anthropic", systemRole: true, role: "system", left: new Map() }) as { messages: unknown[] };
		expect(out.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "second" }] },
			{ role: "system", content: [{ type: "text", text: BUDGET, cache_control: mark }] },
			{ role: "system", content: [] },
		]);
	});

	it("keeps it on the prompt's last block in Haiku's shape", () => {
		const out = withTurnBudgetMessages(prompt(), { shape: "anthropic", systemRole: false, role: "system", left: new Map() }) as { messages: Array<{ content: unknown[] }> };
		expect(out.messages[0].content).toEqual([{ type: "text", text: `${wrapReminder(BUDGET)}\n` }, { type: "text", text: "second", cache_control: mark }]);
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

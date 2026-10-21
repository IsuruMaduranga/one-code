/**
 * A sticky state switched on mid-turn first rides the switching call's
 * result. That first delivery is a told fact recorded with the request, so a
 * request whose reply failed revokes it and the retry pins the state again
 * (code review of the record-once rewrite: it was process memory before).
 */
import { describe, expect, it } from "vitest";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../../extensions/lib/ledger/plan.ts";
import { RECORD } from "../../extensions/lib/ledger/records.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const result = { role: "toolResult", toolCallId: "call-1", toolName: "enter_plan_mode", content: [{ type: "text", text: "entered" }], isError: false, timestamp: 10 };

describe("a sticky state's first delivery follows the branch", () => {
	it("pins the state again on a retry after a failed reply, and not once an answered request told it", async () => {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const ctx = createFakeCtx();
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(REMINDER_CHANNEL, { text: "plan mode is on", key: "permission-mode", placement: "sticky-append", toolCallId: "call-1", since: 5 });

		/** Render the tail [the switching call's result] inside an epoch whose fold told `blocks`. */
		const render = async (blocks: Map<string, string>) => {
			const plan = { epoch: false, fold: { ...foldBranch([]), blocks }, consumed: [], facts: [], carried: [], covers: { count: 1, role: "user", timestamp: 1 }, messages: [] } as unknown as RequestPlan;
			fake.events.emit(LEDGER_PLAN_CHANNEL, plan);
			const out = await fake.fireOne<{ messages: unknown[] } | undefined>("context", { messages: [result] }, ctx);
			return { carried: JSON.stringify(out?.messages ?? []).includes("plan mode is on"), facts: plan.carried.flatMap((block) => block.facts) };
		};

		const first = await render(new Map());
		expect(first.carried).toBe(true);
		expect(first.facts).toHaveLength(1);
		// The reply failed: the fold revokes the request's facts, so the retry's fold has not told it.
		expect((await render(new Map())).carried).toBe(true);
		// Answered: the fold holds the fact, and the pin is not placed again.
		const told = first.facts[0] as { key: string; hash: string };
		expect((await render(new Map([[told.key, told.hash]]))).carried).toBe(false);
	});
});

describe("a sticky state's start follows the branch", () => {
	it("is recorded once and reused by a fresh instance that emits the same state without a start", async () => {
		const first = createFakePi();
		systemReminderExtension(first.pi as never);
		await first.fire("session_start", {}, createFakeCtx({ sessionManager: { getBranch: () => first.branch } }));
		first.events.emit(REMINDER_CHANNEL, { text: "auto mode is on", key: "permission-mode", placement: "sticky-append" });
		const recorded = first.branch.filter((entry) => (entry as { customType?: string }).customType === RECORD.state);
		expect(recorded).toHaveLength(1);
		const since = (recorded[0] as { data: { value: { since: number } } }).data.value.since;

		// A resume: a new instance on the same branch, the owner emitting its state again.
		const second = createFakePi();
		systemReminderExtension(second.pi as never);
		await second.fire("session_start", {}, createFakeCtx({ sessionManager: { getBranch: () => [...first.branch, ...second.branch] } }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		second.events.emit(REMINDER_CHANNEL, { text: "auto mode is on", key: "permission-mode", placement: "sticky-append" });
		expect(second.branch.filter((entry) => (entry as { customType?: string }).customType === RECORD.state)).toEqual([]);
		const render = async () => {
			const plan = { epoch: true, fold: foldBranch([]), consumed: [], facts: [], carried: [], covers: { count: 1, role: "user", timestamp: 1 }, messages: [] } as unknown as RequestPlan;
			second.events.emit(LEDGER_PLAN_CHANNEL, plan);
			return second.fireOne<{ messages: unknown[] } | undefined>("context", { messages: [{ role: "user", content: "earlier", timestamp: since }] }, createFakeCtx());
		};
		expect(JSON.stringify((await render())?.messages ?? [])).toContain("auto mode is on");
	});

	it("ends with a removal: the same state switched on again starts anew and rides the switching call's result", async () => {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => fake.branch } });
		await fake.fire("session_start", {}, ctx);
		/** Render the tail [`call`'s result] inside an epoch whose fold told `blocks`. */
		const render = async (call: string, blocks: Map<string, string>) => {
			const plan = { epoch: false, fold: { ...foldBranch([]), blocks }, consumed: [], facts: [], carried: [], covers: { count: 1, role: "user", timestamp: 1 }, messages: [] } as unknown as RequestPlan;
			fake.events.emit(LEDGER_PLAN_CHANNEL, plan);
			const out = await fake.fireOne<{ messages: unknown[] } | undefined>("context", { messages: [{ ...result, toolCallId: call }] }, ctx);
			return { carried: JSON.stringify(out?.messages ?? []).includes("auto mode is on"), facts: plan.carried.flatMap((block) => block.facts) as { key: string; hash: string }[] };
		};
		fake.events.emit(REMINDER_CHANNEL, { text: "auto mode is on", key: "permission-mode", placement: "sticky-append", toolCallId: "call-1" });
		const first = await render("call-1", new Map());
		expect(first.carried).toBe(true);
		const told = new Map(first.facts.map((fact) => [fact.key, fact.hash]));
		// Switched off, then on again with the same text from another call.
		fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", remove: true });
		await new Promise((resolve) => setTimeout(resolve, 5));
		fake.events.emit(REMINDER_CHANNEL, { text: "auto mode is on", key: "permission-mode", placement: "sticky-append", toolCallId: "call-2" });
		const again = await render("call-2", told);
		expect(again.carried).toBe(true);
		expect(again.facts).toHaveLength(1);
		expect(again.facts[0]?.hash).not.toBe(told.get(again.facts[0]?.key ?? ""));
	});
});

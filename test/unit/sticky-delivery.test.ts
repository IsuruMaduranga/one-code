/**
 * A sticky state switched on mid-turn first rides the switching call's
 * result. That first delivery is a told fact recorded with the request, so a
 * request whose reply failed revokes it and the retry pins the state again
 * (code review of the record-once rewrite: it was process memory before).
 */
import { describe, expect, it } from "vitest";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../../extensions/lib/ledger/plan.ts";
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
			const plan = { epoch: false, fold: { ...foldBranch([]), blocks }, consumed: [], facts: [], covers: { count: 1, role: "user", timestamp: 1 }, messages: [] } as unknown as RequestPlan;
			fake.events.emit(LEDGER_PLAN_CHANNEL, plan);
			const out = await fake.fireOne<{ messages: unknown[] } | undefined>("context", { messages: [result] }, ctx);
			return { carried: JSON.stringify(out?.messages ?? []).includes("plan mode is on"), facts: plan.facts };
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

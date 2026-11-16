/**
 * A turn a `!` run starts ends in the run's record, which carries the tail's
 * reminders; the next request cuts above it and so keeps the bytes it went out
 * with (lib/request/reminders.ts, lib/request/ledger/plan.ts).
 */
import { describe, expect, it } from "vitest";
import { foldBranch, type LedgerFold } from "../../extensions/lib/request/ledger/fold.ts";
import { coverageOf, LEDGER_PLAN_CHANNEL, planRequest } from "../../extensions/lib/request/ledger/plan.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import systemReminderExtension from "../../extensions/request/system-reminder/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const MARKER = "<total_tokens>15000000 tokens left</total_tokens>";
const hi = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
const reply = (timestamp: number) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp });
const run = { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 };
const trigger = { role: "custom", customType: "one-code:bash-turn", content: [], display: false, timestamp: 4 };
const next = { role: "user", content: [{ type: "text", text: "next" }], timestamp: 6 };

/** A fold whose last answered request covered `messages`. */
const foldAfter = (messages: Array<{ role: string; timestamp: number }>): LedgerFold => ({ ...foldBranch([]), opensEpoch: false, lastRequest: { covers: coverageOf(messages) } as never });

async function renderer() {
	const fake = createFakePi();
	systemReminderExtension(fake.pi as never);
	const ctx = createFakeCtx();
	await fake.fire("session_start", {}, ctx);
	// context-budget's constant line: on every user message after the first.
	fake.events.emit(REMINDER_CHANNEL, { text: MARKER, key: "total-tokens", placement: "sticky-append", raw: true, since: 0, skipStackCarrier: true });
	fake.events.emit(REMINDER_CHANNEL, { text: "# Environment", key: "environment", placement: "first-prepend", order: 1 });
	/** What the request over pi's `messages` sends through pi: its tail with the reminders on it. */
	return async (fold: LedgerFold, messages: unknown[]) => {
		const { plan, tailStart } = planRequest(fold, messages as Array<{ role: string; timestamp: number }>);
		fake.events.emit(LEDGER_PLAN_CHANNEL, plan);
		const tail = messages.slice(tailStart);
		const out = await fake.fireOne<{ messages: unknown[] } | undefined>("context", { messages: tail }, ctx);
		return { tailStart, sent: (out?.messages ?? tail) as Array<{ role: string; content: Array<{ text: string }> }> };
	};
}

describe("the record of a `!` run as the carrier", () => {
	it("ends the triggered request with the record and its reminders, and nothing after it", async () => {
		const render = await renderer();
		const { tailStart, sent } = await render(foldAfter([hi, reply(2)]), [hi, reply(2), run, trigger]);
		expect(tailStart).toBe(2);
		expect(sent).toEqual([{ role: "user", content: [{ type: "text", text: "Ran `pwd`\n```\n/tmp\n```" }, { type: "text", text: MARKER }], timestamp: 3 }]);
	});

	it("leaves the record above the next request's cut, so it keeps the bytes it was sent with", async () => {
		const render = await renderer();
		const first = [hi, reply(2), run, trigger];
		const later = [...first, reply(5), next];
		const { tailStart, sent } = await render(foldAfter(first), later);
		// The triggered request covered pi's four messages, the silent one included: the cut is after it.
		expect(tailStart).toBe(4);
		expect(JSON.stringify(sent)).not.toContain("Ran `pwd`");
		expect(sent.at(-1)?.content.map((block) => block.text)).toEqual(["next", MARKER]);
	});

	it("puts the record and a typed prompt it waited for in one tail, each with the constant line", async () => {
		const render = await renderer();
		// A `!` run while the model worked: pi queued the record until the turn ended, and the next prompt carries it.
		const { sent } = await render(foldAfter([hi, reply(2)]), [hi, reply(2), run, next]);
		expect(sent.map((m) => m.content.map((block) => block.text))).toEqual([
			["Ran `pwd`\n```\n/tmp\n```", MARKER],
			["next", MARKER],
		]);
	});

	it("carries the first-message stack when the `!` run is the session's first input", async () => {
		const render = await renderer();
		const { sent } = await render({ ...foldBranch([]), opensEpoch: true, cause: "first" }, [run, trigger]);
		// The constant line skips the message that carries the stack.
		expect(sent.map((m) => m.content.map((block) => block.text))).toEqual([["<system-reminder>\n# Environment\n</system-reminder>", "Ran `pwd`\n```\n/tmp\n```"]]);
	});
});

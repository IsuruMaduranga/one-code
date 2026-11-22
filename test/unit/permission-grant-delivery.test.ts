/**
 * Where an approval made in `/permissions` without a retry reaches the model
 * (`permissionGrantReminder`): idle, raw before the next prompt's text; while
 * a turn runs, on that turn's next request (its trailing tool result), once;
 * and when the turn ends before another request, before the next prompt's
 * text. Runs the real system-reminder extension, which persists the grant as
 * a pending entry on the branch and places it when a request renders.
 */
import { describe, expect, it } from "vitest";
import { foldBranch } from "../../extensions/lib/request/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../../extensions/lib/request/ledger/plan.ts";
import { REMINDER_CHANNEL, wrapReminder } from "../../extensions/lib/request/reminders.ts";
import systemReminderExtension from "../../extensions/request/system-reminder/index.ts";
import { permissionGrantedMessage, permissionGrantReminder } from "../../extensions/safety/permissions/auto-mode/denials.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const DISPLAY = "bash(rm -rf /outside/elsewhere)";
const GRANT = permissionGrantedMessage([DISPLAY]);

type Message = { role: string; content: Array<{ type: string; text: string }> | string; timestamp: number; toolCallId?: string };
const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (timestamp: number): Message => ({ role: "assistant", content: [{ type: "text", text: "working" }], timestamp });
const toolResult = (text: string, timestamp: number): Message => ({ role: "toolResult", toolCallId: `c${timestamp}`, content: [{ type: "text", text }], timestamp });

const texts = (message: unknown): string[] => {
	const content = (message as Message).content;
	return typeof content === "string" ? [content] : content.map((block) => block.text);
};

async function session() {
	const fake = createFakePi();
	systemReminderExtension(fake.pi as never);
	const ctx = createFakeCtx({ sessionManager: { getSessionId: () => "s1", getBranch: () => fake.branch } });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	/** One request inside an epoch: its tail through the renderer, with no ledger (the extension remembers what it delivered). */
	const request = async (tail: Message[]): Promise<Message[]> => {
		const out = await fake.fireOne<{ messages: Message[] } | undefined>("context", { messages: tail }, ctx);
		return out?.messages ?? tail;
	};
	return { fake, ctx, request };
}

describe("permissionGrantReminder", () => {
	it("idle: the grant is raw, before the next prompt's text, as before", async () => {
		expect(permissionGrantReminder([DISPLAY], false)).toEqual({ text: `${GRANT}\n`, placement: "user-prepend", raw: true });
		const { fake, request } = await session();
		fake.events.emit(REMINDER_CHANNEL, permissionGrantReminder([DISPLAY], false));
		const next = await request([user("go on", 1)]);
		expect(texts(next[0])).toEqual([`${GRANT}\n`, "go on"]);
		// Spent: a later request of the same turn carries nothing more.
		const later = await request([assistant(2), toolResult("ran", 3)]);
		expect(later.flatMap(texts).some((text) => text.includes(GRANT))).toBe(false);
	});

	it("idle: a grant without orTail never rides a tool result, so a running turn would not see it", async () => {
		const { fake, request } = await session();
		fake.events.emit(REMINDER_CHANNEL, permissionGrantReminder([DISPLAY], false));
		const midTurn = await request([assistant(2), toolResult("ran", 3)]);
		expect(midTurn.flatMap(texts).some((text) => text.includes(GRANT))).toBe(false);
	});

	it("while a turn runs: the turn's next request carries it once, framed, on the trailing tool result", async () => {
		const { fake, request } = await session();
		fake.events.emit(REMINDER_CHANNEL, permissionGrantReminder([DISPLAY], true));
		const next = await request([assistant(2), toolResult("ran", 3)]);
		expect(texts(next[1])).toEqual(["ran", wrapReminder(GRANT)]);
		expect(texts(next[0])).toEqual(["working"]);
		// The request after it, and the next prompt, carry nothing more.
		const after = await request([assistant(4), toolResult("ran again", 5)]);
		expect(after.flatMap(texts).some((text) => text.includes(GRANT))).toBe(false);
		const prompt = await request([assistant(6), user("thanks", 7)]);
		expect(prompt.flatMap(texts).some((text) => text.includes(GRANT))).toBe(false);
	});

	it("while a turn runs: the ledger's plan records the pending entry consumed by the request that carries it", async () => {
		const { fake, ctx } = await session();
		fake.events.emit(REMINDER_CHANNEL, permissionGrantReminder([DISPLAY], true));
		const pending = foldBranch(fake.branch as never).pending;
		expect(pending.map((item) => item.text)).toEqual([GRANT]);
		const plan = { epoch: false, fold: foldBranch(fake.branch as never), consumed: [], facts: [], carried: [], covers: { count: 1, role: "user", timestamp: 1 }, messages: [] } as unknown as RequestPlan;
		fake.events.emit(LEDGER_PLAN_CHANNEL, plan);
		const out = await fake.fireOne<{ messages: Message[] } | undefined>("context", { messages: [assistant(2), toolResult("ran", 3)] }, ctx);
		expect(texts(out?.messages[1])).toEqual(["ran", wrapReminder(GRANT)]);
		expect(plan.consumed).toEqual([pending[0]?.id]);
	});

	it("a turn that ends before another request: the next prompt carries it, before its text, once", async () => {
		const { fake, request } = await session();
		fake.events.emit(REMINDER_CHANNEL, permissionGrantReminder([DISPLAY], true));
		// The turn's last reply was already streaming: no request goes out until the user types.
		const next = await request([assistant(2), user("did it work?", 3)]);
		expect(texts(next[1])).toEqual([wrapReminder(GRANT), "did it work?"]);
		const later = await request([assistant(4), toolResult("ran", 5)]);
		expect(later.flatMap(texts).some((text) => text.includes(GRANT))).toBe(false);
	});
});

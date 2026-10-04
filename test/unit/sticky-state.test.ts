import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { CONTEXT_STACK_ENTRY, CONTEXT_STATE_ENTRY, contextStackOnBranch } from "../../extensions/lib/context-stack.ts";
import { injectReminders, ReminderQueue, REMINDER_CHANNEL, wrapReminder } from "../../extensions/lib/reminders.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const result = (toolCallId: string, timestamp: number): AgentMessage => ({ role: "toolResult", toolCallId, toolName: "enter_worktree", content: [{ type: "text", text: toolCallId }], isError: false, timestamp });
const summary = (timestamp: number): AgentMessage => ({ role: "compactionSummary", summary: "old turns folded", tokensBefore: 100, timestamp } as AgentMessage);
const texts = (message: AgentMessage) => typeof (message as any).content === "string" ? [(message as any).content] : ((message as any).content ?? []).map((b: any) => b.text);
const enable = (queue: ReminderQueue, key: string, text = key) => queue.enqueue(text, { key, scope: "every-turn", placement: "sticky-append" });
const render = (queue: ReminderQueue, messages: AgentMessage[]) => injectReminders(messages, queue.drain(messages));

describe("sticky state lifetimes", () => {
	it("closing plan preserves earlier bytes but never labels later turns active", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		enable(queue, "permission-mode", "Plan mode is active");
		const before = [user("plan one", 20), user("plan two", 30)];
		const sent = render(queue, before);
		now = 40;
		queue.remove("permission-mode");
		const after = render(queue, [...before, user("implement", 50)]);
		expect(JSON.stringify(after.slice(0, 2))).toBe(JSON.stringify(sent));
		expect(texts(after[2])).toEqual(["implement"]);
	});

	it("auto off then on opens a separate interval and preserves other sticky ordering", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		enable(queue, "permission-mode", "AUTO");
		enable(queue, "budget", "BUDGET");
		const first = [user("auto one", 20)];
		const sent = render(queue, first);
		now = 30;
		queue.remove("permission-mode");
		const off = [...first, user("manual", 40)];
		const offSent = render(queue, off);
		now = 50;
		enable(queue, "permission-mode", "AUTO");
		const next = render(queue, [...off, user("auto two", 60)]);
		expect(next[0]).toEqual(sent[0]);
		expect(next.slice(0, 2)).toEqual(offSent);
		expect(texts(next[1])).toEqual(["manual", wrapReminder("BUDGET")]);
		expect(texts(next[2])).toEqual(["auto two", wrapReminder("BUDGET"), wrapReminder("AUTO")]);
	});

	it("replacing plan with auto closes the old block without rewriting its carriers", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		enable(queue, "permission-mode", "PLAN");
		const before = [user("plan", 20)];
		const sent = render(queue, before);
		now = 30;
		enable(queue, "permission-mode", "AUTO");
		const next = render(queue, [...before, user("run", 40)]);
		expect(next[0]).toEqual(sent[0]);
		expect(texts(next[1])).toEqual(["run", wrapReminder("AUTO")]);
	});

	it("enter_worktree first rides the switching result, never the already-sent opener", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		const before = [user("read then enter worktree", 10), result("read-before", 20)];
		const sent = render(queue, before);
		now = 30;
		enable(queue, "worktree", "Worktree session active");
		const switched = [...before, result("entered", 31), result("parallel-later", 32)];
		const next = render(queue, switched);
		expect(next.slice(0, 2)).toEqual(sent);
		expect(texts(next[2])).toEqual(["entered", wrapReminder("Worktree session active")]);
		expect(texts(next[3])).toEqual(["parallel-later"]);
		expect(render(queue, [...switched, user("continue", 40)]).slice(0, 4)).toEqual(next);
		now = 50;
		queue.remove("worktree");
		expect(render(queue, [...switched, user("outside", 60)]).slice(0, 4)).toEqual(next);
	});

	it("does not backdate a switch when no new carrier exists yet", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		const previous = [user("old prompt", 10)];
		const sent = render(queue, previous);
		now = 20;
		enable(queue, "worktree");
		expect(render(queue, previous)).toEqual(sent);
		const next = render(queue, [...previous, user("new prompt", 30)]);
		expect(next[0]).toEqual(sent[0]);
		expect(texts(next[1])).toEqual(["new prompt", wrapReminder("worktree")]);
	});

	it("keeps closed blocks on surviving turns at compaction, drops fully folded lifetimes, and never puts them on the summary", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		enable(queue, "permission-mode", "PLAN");
		const before = [user("old", 20), user("retained", 30)];
		const sent = render(queue, before);
		now = 40;
		queue.remove("permission-mode");
		const compacted = render(queue, [summary(50), before[1], user("after", 60)]);
		expect(compacted[1]).toEqual(sent[1]);
		expect(JSON.stringify(compacted[0])).not.toContain("PLAN");
		expect(texts(compacted[2])).toEqual(["after"]);
		const folded = render(queue, [summary(70), user("new prefix", 80)]);
		expect(JSON.stringify(folded)).not.toContain("PLAN");
		expect(queue.persistentEntries("sticky-append")).toEqual([]);
	});

	it("does not invent a skipped stack-carrier block when closed history survives compaction", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		queue.enqueue("BUDGET", { key: "budget", scope: "every-turn", placement: "sticky-append", skipStackCarrier: true });
		const first = user("first", 20);
		const second = user("second", 30);
		const sent = render(queue, [first, second]);
		now = 40;
		queue.remove("budget");
		const compacted = render(queue, [summary(50), first, second]);
		expect(compacted.slice(1)).toEqual(sent);
	});

	it("keeps a closed no-user tail pin until that tool result is compacted away", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		enable(queue, "permission-mode", "PLAN");
		const before = [summary(15), result("retry", 20)];
		const sent = render(queue, before);
		now = 30;
		queue.remove("permission-mode");
		const next = render(queue, [...before, user("not planning", 40)]);
		expect(next[1]).toEqual(sent[1]);
		expect(texts(next[2])).toEqual(["not planning"]);
		expect(JSON.stringify(render(queue, [summary(50), user("new", 60)]))).not.toContain("PLAN");
	});
});

describe("closed sticky persistence", () => {
	it("resumes the switch one-shot alongside its closed history without changing bytes", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(10);
		try {
			const fake = createFakePi();
			systemReminderExtension(fake.pi as never);
			const ctx = createFakeCtx({ sessionManager: { getBranch: () => [] } });
			await fake.fire("session_start", {}, ctx);
			fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", text: "PLAN", placement: "sticky-append", scope: "every-turn" });
			await fake.fireOne("context", { messages: [user("plan", 20)] }, ctx);
			clock.mockReturnValue(30);
			fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", remove: true });
			fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode-change", text: 'The user\'s permission mode is now "default".' });
			const messages = [user("plan", 20), user("continue", 40)];
			const sent = (await fake.fireOne<{ messages: AgentMessage[] }>("context", { messages }, ctx))!.messages;
			const branch = fake.appendedEntries.map((entry) => ({ type: "custom", ...JSON.parse(JSON.stringify(entry)) }));
			const resumed = createFakePi();
			systemReminderExtension(resumed.pi as never);
			const resumedCtx = createFakeCtx({ sessionManager: { getBranch: () => branch } });
			await resumed.fire("session_start", {}, resumedCtx);
			const replay = (await resumed.fireOne<{ messages: AgentMessage[] }>("context", { messages }, resumedCtx))!.messages;
			expect(JSON.stringify(replay)).toBe(JSON.stringify(sent));
		} finally {
			clock.mockRestore();
		}
	});

	it("restores closed and reopened lifetimes with identical earlier bytes", async () => {
		const clock = vi.spyOn(Date, "now");
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => [] } });
		await fake.fire("session_start", {}, ctx);
		const request = async (messages: AgentMessage[]) => (await fake.fireOne<{ messages: AgentMessage[] }>("context", { messages }, ctx))?.messages ?? messages;
		try {
			clock.mockReturnValue(10);
			fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", text: "PLAN", scope: "every-turn", placement: "sticky-append" });
			const messages = [user("plan", 20)];
			const first = await request(messages);
			clock.mockReturnValue(30);
			fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", remove: true });
			const closed = await request([...messages, user("manual", 40)]);
			expect(closed[0]).toEqual(first[0]);
			const branch = fake.appendedEntries.map((entry) => ({ type: "custom", ...JSON.parse(JSON.stringify(entry)) }));
			expect(branch.map((entry) => entry.customType)).toEqual([CONTEXT_STACK_ENTRY, CONTEXT_STATE_ENTRY]);
			const saved = contextStackOnBranch(branch)!;
			expect(saved.sticky).toHaveLength(1);
			const resumed = new ReminderQueue(() => 50);
			resumed.restore(saved.stack, saved.sticky, new Set());
			enable(resumed, "permission-mode", "PLAN");
			const restored = render(resumed, [...messages, user("manual", 40), user("plan again", 60)]);
			expect(JSON.stringify(restored.slice(0, 2))).toBe(JSON.stringify(closed));
			expect(texts(restored[2])).toEqual(["plan again", wrapReminder("PLAN")]);
		} finally {
			clock.mockRestore();
		}
	});
});

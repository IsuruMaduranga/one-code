import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { injectReminders, ReminderQueue, wrapReminder } from "../../extensions/lib/reminders.ts";
import { CONTEXT_STACK_ENTRY, contextStackOnBranch } from "../../extensions/lib/context-stack.ts";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const result = (toolCallId: string, timestamp: number): AgentMessage => ({ role: "toolResult", toolCallId, toolName: toolCallId, content: [{ type: "text", text: toolCallId }], isError: false, timestamp });
const render = (queue: ReminderQueue, messages: AgentMessage[]) => injectReminders(messages, queue.drain(messages));
const enable = (queue: ReminderQueue, text = "PLAN") => queue.enqueue(text, { key: "mode", placement: "sticky-append", scope: "every-turn" });
const text = (message: AgentMessage) => JSON.stringify((message as any).content);

describe("sticky review: delivery boundaries", () => {
	it("does not apply a closed state to a steer first consumed after the switch", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		enable(queue);
		const prompt = user("plan the work", 20);
		const sent = render(queue, [prompt]);
		// Typed while the model is working, but queued until the tool batch ends.
		const steer = user("continue after approval", 25);
		now = 30;
		queue.remove("mode");
		const next = render(queue, [prompt, result("exit_plan_mode", 31), steer]);
		expect(next[0]).toEqual(sent[0]);
		expect(text(next[2])).not.toContain("PLAN");
	});

	it("does not invent a never-delivered sticky lifetime when queued input predates its close", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		const prompt = user("work", 5);
		const sent = render(queue, [prompt]);
		enable(queue);
		const steer = user("more work", 15);
		now = 20;
		queue.remove("mode");
		const next = render(queue, [prompt, result("mode switched twice", 21), steer]);
		expect(next[0]).toEqual(sent[0]);
		expect(text(next[2])).not.toContain("PLAN");
		expect(queue.persistentEntries("sticky-append")).toEqual([]);
	});

	it("uses the switching tool's result even when an earlier parallel result is stamped after activation", () => {
		let now = 10;
		const queue = new ReminderQueue(() => now);
		const prompt = user("read then enter a worktree", 10);
		const sent = render(queue, [prompt]);
		// pi parallel batches stamp all tool result messages only after Promise.all,
		// retaining call order even when the earlier read finished before the switch.
		now = 30;
		queue.enqueue("WORKTREE", { key: "worktree", placement: "sticky-append", scope: "every-turn", toolCallId: "enter_worktree" });
		const next = render(queue, [prompt, result("read-before", 40), result("enter_worktree", 40)]);
		expect(next[0]).toEqual(sent[0]);
		expect(text(next[1])).not.toContain("WORKTREE");
		expect(text(next[2])).toContain("WORKTREE");
	});

	it("retains an unresolved switching-call binding through no-carrier drain and snapshot restore", () => {
		const queue = new ReminderQueue(() => 30);
		const prompt = user("enter a worktree", 10);
		queue.enqueue("WORKTREE", { key: "worktree", placement: "sticky-append", scope: "every-turn", toolCallId: "enter_worktree" });
		expect(render(queue, [prompt, result("unrelated", 40)])).toEqual([prompt, result("unrelated", 40)]);
		const saved = contextStackOnBranch([{ type: "custom", customType: CONTEXT_STACK_ENTRY, data: JSON.parse(JSON.stringify({ version: 1, stack: [], sticky: queue.persistentEntries("sticky-append"), baselines: {} })) }])!;
		expect(saved.sticky[0].toolCallId).toBe("enter_worktree");
		const resumed = new ReminderQueue(() => 50);
		resumed.restore(saved.stack, saved.sticky, new Set());
		const messages = [prompt, result("unrelated", 40), result("enter_worktree", 60)];
		const sent = render(resumed, messages);
		expect(text(sent[1])).not.toContain("WORKTREE");
		expect(text(sent[2])).toContain("WORKTREE");
		expect(resumed.persistentEntries("sticky-append")[0]).toMatchObject({ tailPin: { kind: "toolResult", toolCallId: "enter_worktree" } });
		expect(resumed.persistentEntries("sticky-append")[0].toolCallId).toBeUndefined();
	});

	it("keeps a delivered bound pin after close and drops it only when compaction removes its result", () => {
		let now = 30;
		const queue = new ReminderQueue(() => now);
		queue.enqueue("WORKTREE", { key: "worktree", placement: "sticky-append", scope: "every-turn", toolCallId: "enter_worktree" });
		const messages = [user("enter a worktree", 10), result("enter_worktree", 40)];
		const sent = render(queue, messages);
		now = 50;
		queue.remove("worktree");
		const after = render(queue, [...messages, user("outside", 60)]);
		expect(after.slice(0, 2)).toEqual(sent);
		expect(text(after[2])).not.toContain("WORKTREE");
		const summary = { role: "compactionSummary", summary: "folded", tokensBefore: 100, timestamp: 70 } as AgentMessage;
		expect(render(queue, [summary])).toEqual([summary]);
		expect(queue.persistentEntries("sticky-append")).toEqual([]);
	});

	it("lets a still-active delivered binding fall back to the new tail after compaction", () => {
		const queue = new ReminderQueue(() => 30);
		queue.enqueue("WORKTREE", { key: "worktree", placement: "sticky-append", scope: "every-turn", toolCallId: "enter_worktree" });
		render(queue, [user("enter a worktree", 10), result("enter_worktree", 40)]);
		const summary = { role: "compactionSummary", summary: "folded", tokensBefore: 100, timestamp: 70 } as AgentMessage;
		const next = render(queue, [summary, result("new tail", 80)]);
		expect(text(next[1])).toContain("WORKTREE");
		expect(queue.persistentEntries("sticky-append")[0].tailPin).toEqual({ kind: "toolResult", toolCallId: "new tail" });
	});

	it("keeps a restored legacy opener when closing its lifetime", () => {
		const queue = new ReminderQueue(() => 100);
		queue.restore([], [{ key: "mode", text: "PLAN", placement: "sticky-append", order: 0, since: 50, opener: 20 }], new Set());
		const prompt = user("old opener", 20);
		const before = render(queue, [prompt]);
		queue.remove("mode");
		const after = render(queue, [prompt, user("manual", 110)]);
		expect(after[0]).toEqual(before[0]);
		expect(text(after[0])).toContain(JSON.stringify(wrapReminder("PLAN")).slice(1, -1));
		expect(text(after[1])).not.toContain("PLAN");
	});
});

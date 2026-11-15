import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTaskNotifier,
	NOTIFICATION_ID_KEY,
	TASK_COMPLETION_KEY,
	TASK_OUTPUT_DELIVERED_CHANNEL,
	taskNotification,
} from "../../extensions/lib/notify/notifications.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const completion = (taskId: string) => taskNotification({ kind: "shell", taskId, status: "completed", summary: `${taskId} finished` });
/** A completion's details, as its producer marks them. */
const completes = (taskId: string) => ({ taskId, [TASK_COMPLETION_KEY]: true });
const textAt = (fake: FakePi, index: number) => (fake.sentMessages[index].message.content as Array<{ text: string }>)[0].text;
const interrupt = async (fake: FakePi) => {
	await fake.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	await fake.fire("agent_settled", {});
};

describe("notification lifecycle races", () => {
	afterEach(() => vi.useRealTimers());

	it("a run an extension opened (pi 1.2.0 messageType custom) does not release held frames as riding a user prompt", async () => {
		const fake = createFakePi();
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 0 });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		await interrupt(fake);
		notify("task-notification", completion("held"), { taskId: "held" });
		const sentBefore = fake.sentMessages.length;
		await fake.fire("before_agent_start", { messageType: "custom", message: { role: "custom" } });
		expect(fake.sentMessages).toHaveLength(sentBefore);
		await fake.fire("agent_start", {});
		expect(fake.sentMessages).toHaveLength(sentBefore + 1);
		expect(fake.sentMessages[sentBefore].options).not.toEqual({ deliverAs: "nextTurn" });
	});

	it("confirming one producer cannot acknowledge another producer's simultaneous notification", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
		const fake = createFakePi();
		const shellNotify = createTaskNotifier(fake.pi as never, { coalesceMs: 0 });
		const monitorNotify = createTaskNotifier(fake.pi as never, { coalesceMs: 0 });
		await fake.fire("before_agent_start", {}, createFakeCtx());
		await fake.fire("agent_start", {});
		shellNotify("task-notification", completion("shell"), { taskId: "shell" });
		monitorNotify("task-notification", completion("monitor"), { taskId: "monitor" });
		const firstDetails = fake.sentMessages[0].message.details as Record<string, unknown>;
		const secondDetails = fake.sentMessages[1].message.details as Record<string, unknown>;
		await fake.fire("message_end", { message: { role: "custom", details: firstDetails } });
		// Esc discarded only the monitor's still-queued completion.
		await interrupt(fake);
		await fake.fire("before_agent_start", {});
		expect(fake.sentMessages).toHaveLength(3);
		expect(textAt(fake, 2)).toContain("<task-id>monitor</task-id>");
		expect(textAt(fake, 2)).not.toContain("<task-id>shell</task-id>");
		expect(firstDetails[NOTIFICATION_ID_KEY]).not.toBe(secondDetails[NOTIFICATION_ID_KEY]);
	});

	it.each(["discarded mid-turn", "arrived during hold"])("withdraws one task from a coalesced completion that was %s", async (arrival) => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 250, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		if (arrival === "arrived during hold") await interrupt(fake);
		notify("task-notification", completion("first"), completes("first"));
		notify("task-notification", completion("second"), completes("second"));
		await vi.advanceTimersByTimeAsync(250);
		if (arrival === "discarded mid-turn") await interrupt(fake);
		// A finished task_output delivers the first task before the held group is released.
		fake.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "first" });
		const sentBefore = fake.sentMessages.length;
		await fake.fire("before_agent_start", {});
		expect(fake.sentMessages).toHaveLength(sentBefore + 1);
		const released = textAt(fake, sentBefore);
		expect(released).not.toContain("<task-id>first</task-id>");
		expect(released).toContain("<task-id>second</task-id>");
	});

	it("leaves a sent completion in pi's queue, never sends it again after an interrupt, and withdraws one still coalescing", async () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 250, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		notify("task-notification", completion("first"), completes("first"));
		notify("task-notification", completion("second"), completes("second"));
		await vi.advanceTimersByTimeAsync(250);
		notify("task-notification", completion("third"), completes("third"));
		const sentBefore = fake.sentMessages.length;
		// task_output returns the output of a task whose completion already waits
		// in pi's queue (it lands as well: a duplicate, accepted) and of one still
		// in the coalescing window (withdrawn).
		fake.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "first" });
		fake.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "third" });
		await vi.advanceTimersByTimeAsync(250);
		expect(fake.sentMessages).toHaveLength(sentBefore);
		// Esc discards pi's queue: the resend keeps its peer and drops the completion task_output returned.
		await interrupt(fake);
		const afterInterrupt = fake.sentMessages.length;
		await fake.fire("before_agent_start", {});
		expect(fake.sentMessages).toHaveLength(afterInterrupt + 1);
		const released = textAt(fake, afterInterrupt);
		expect(released).not.toContain("<task-id>first</task-id>");
		expect(released).toContain("<task-id>second</task-id>");
		expect(released).not.toContain("<task-id>third</task-id>");
	});

	it("withdraws only the task's completion: its progress message and other tasks' notifications stay", async () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 250, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		notify("subagent-message", "<agent-message from=\"a1\">checking one last file</agent-message>", { taskId: "a1", name: "a1" });
		notify("task-notification", completion("a1"), completes("a1"));
		notify("task-notification", completion("other"), completes("other"));
		fake.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "a1" });
		await vi.advanceTimersByTimeAsync(250);
		const sent = fake.sentMessages.map((_, index) => textAt(fake, index)).join("\n");
		expect(sent).toContain("checking one last file");
		expect(sent).toContain("<task-id>other</task-id>");
		expect(sent).not.toContain("<task-id>a1</task-id>");
	});
});

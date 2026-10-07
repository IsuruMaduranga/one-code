import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTaskNotifier,
	NOTIFICATION_ID_KEY,
	TASK_OUTPUT_DELIVERED_CHANNEL,
	taskNotification,
} from "../../extensions/lib/notifications.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const completion = (taskId: string) => taskNotification({ kind: "shell", taskId, status: "completed", summary: `${taskId} finished` });
const textAt = (fake: FakePi, index: number) => (fake.sentMessages[index].message.content as Array<{ text: string }>)[0].text;
const interrupt = async (fake: FakePi) => {
	await fake.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	await fake.fire("agent_settled", {});
};

describe("notification lifecycle races", () => {
	afterEach(() => vi.useRealTimers());

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
		notify("task-notification", completion("first"), { taskId: "first" });
		notify("task-notification", completion("second"), { taskId: "second" });
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

	it("withdraws a task from a sent completion still awaiting confirmation, so an interrupt does not resend it", async () => {
		vi.useFakeTimers();
		const fake = createFakePi();
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 250, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		notify("task-notification", completion("first"), { taskId: "first" });
		notify("task-notification", completion("second"), { taskId: "second" });
		notify("task-notification", completion("lone"), { taskId: "lone" });
		await vi.advanceTimersByTimeAsync(250);
		notify("task-notification", completion("lone"), { taskId: "lone" });
		await vi.advanceTimersByTimeAsync(250);
		// task_output delivers two tasks while their completions wait in pi's
		// queue; then Esc discards that queue.
		fake.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "first" });
		fake.events.emit(TASK_OUTPUT_DELIVERED_CHANNEL, { taskId: "lone" });
		await interrupt(fake);
		const sentBefore = fake.sentMessages.length;
		await fake.fire("before_agent_start", {});
		expect(fake.sentMessages).toHaveLength(sentBefore + 1);
		const released = textAt(fake, sentBefore);
		expect(released).not.toContain("<task-id>first</task-id>");
		expect(released).not.toContain("<task-id>lone</task-id>");
		expect(released).toContain("<task-id>second</task-id>");
	});
});

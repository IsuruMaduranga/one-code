/**
 * background/index.ts wiring (T15d): the monitor tool's event batching (a real
 * child process, no fake timers needed — a monitor whose command finishes
 * flushes its pending batch synchronously, so the cap/overflow reporting is
 * observable without waiting out MONITOR_BATCH_IDLE_MS), task_stop/task_output
 * around a still-running task, and the /loop + schedule_wakeup timers (fake
 * timers, no external process).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundExtension from "../../extensions/background/index.ts";
import { MONITOR_BATCH_MAX_LINES } from "../../extensions/background/monitor-batch.ts";
import { NOTIFICATION_ID_KEY } from "../../extensions/lib/notifications.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

function mount(): FakePi {
	const fake = createFakePi();
	backgroundExtension(fake.pi as never);
	return fake;
}

describe("background wiring: monitor batching", () => {
	it("flushes a batch (capped, with overflow count) as soon as the command exits", async () => {
		const fake = mount();
		const ctx = createFakeCtx({ hasUI: true });
		const monitor = fake.tools.get("monitor")!;
		const lineCount = MONITOR_BATCH_MAX_LINES + 10;
		const start = (await monitor.execute(
			"c1",
			{ command: `for i in $(seq 1 ${lineCount}); do echo line$i; done`, description: "many lines" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		const taskId = start.details.taskId;

		const taskOutput = fake.tools.get("task_output")!;
		await taskOutput.execute("c2", { task_id: taskId, block: true, timeout: 5000 }, undefined, undefined, ctx);

		const batchMessage = fake.sentMessages.find((m) => {
			const text = (m.message.content as Array<{ text?: string }>)[0]?.text ?? "";
			return text.includes(`emitted ${lineCount} event(s)`);
		});
		expect(batchMessage).toBeDefined();
		const batchText = (batchMessage!.message.content as Array<{ text: string }>)[0].text;
		expect(batchText).toContain(`+10 more line(s) not shown — task_output ${taskId} has the full stream`);

		const completion = fake.sentMessages.find((m) => {
			const text = (m.message.content as Array<{ text?: string }>)[0]?.text ?? "";
			return text.includes("completed") && text.includes(`after ${lineCount} event(s)`);
		});
		expect(completion).toBeDefined();
		// Delivery policy: steered mid-turn, and able to start a turn on its own.
		expect(batchMessage!.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	});

	it("task_stop ends a still-running monitor; task_output then reports it stopped", async () => {
		const fake = mount();
		const ctx = createFakeCtx({ hasUI: true });
		const monitor = fake.tools.get("monitor")!;
		const start = (await monitor.execute(
			"c1",
			{ command: "sleep 30", description: "long runner" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		const taskId = start.details.taskId;

		const taskStop = fake.tools.get("task_stop")!;
		const stopResult = (await taskStop.execute("c2", { task_id: taskId }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(stopResult.content[0].text).toContain("Stop requested");

		const taskOutput = fake.tools.get("task_output")!;
		const outputResult = (await taskOutput.execute("c3", { task_id: taskId, block: true, timeout: 5000 }, undefined, undefined, ctx)) as {
			details: { status: string };
		};
		expect(outputResult.details.status).toBe("stopped");
	});

	it("task_output/task_stop report a clear error for an unknown task id", async () => {
		const fake = mount();
		const ctx = createFakeCtx({ hasUI: true });
		const result = (await fake.tools.get("task_output")!.execute("c1", { task_id: "nope" }, undefined, undefined, ctx)) as {
			isError: boolean;
			content: Array<{ text: string }>;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('No background task "nope"');
	});
});

describe("background wiring: /loop and schedule_wakeup timers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedule_wakeup fires the framed follow-up after the (clamped) delay, and stop cancels it", async () => {
		vi.useFakeTimers();
		const fake = mount();
		const ctx = createFakeCtx({ hasUI: true });
		const schedule = fake.tools.get("schedule_wakeup")!;

		const scheduled = (await schedule.execute(
			"c1",
			{ delaySeconds: 5, prompt: "check the build", reason: "quick poll" },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ text: string }> };
		// 5s is below the 60s floor, so it is clamped and the tool says so.
		expect(scheduled.content[0].text).toContain("adjusted from 5s");

		await vi.advanceTimersByTimeAsync(60_000);
		const wakeup = fake.sentMessages.find((m) => m.message.customType === "wakeup");
		expect(wakeup).toBeDefined();
		const text = (wakeup!.message.content as Array<{ text: string }>)[0].text;
		expect(text).toContain("check the build");
		expect(text).toContain("quick poll");

		// Scheduling again and then stopping must cancel the pending timer.
		fake.sentMessages.length = 0;
		await schedule.execute("c2", { delaySeconds: 60, prompt: "again", reason: "r" }, undefined, undefined, ctx);
		await schedule.execute("c3", { stop: true }, undefined, undefined, ctx);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sentMessages.find((m) => m.message.customType === "wakeup")).toBeUndefined();
	});

	it("rejects an incomplete reschedule without touching a pending wakeup", async () => {
		vi.useFakeTimers();
		const fake = mount();
		const ctx = createFakeCtx({ hasUI: true });
		const schedule = fake.tools.get("schedule_wakeup")!;

		await schedule.execute("c1", { delaySeconds: 120, prompt: "task", reason: "r" }, undefined, undefined, ctx);
		const rejected = (await schedule.execute("c2", { delaySeconds: 60 }, undefined, undefined, ctx)) as {
			isError: boolean;
			content: Array<{ text: string }>;
		};
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0].text).toContain("previous wakeup is still pending");

		// The original schedule is untouched: it still fires.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sentMessages.find((m) => m.message.customType === "wakeup")).toBeDefined();
	});

	it("a fixed-interval /loop fires immediately, skips a tick while the agent is busy, and /loop stop clears it", async () => {
		vi.useFakeTimers();
		const fake = mount();
		const notify = vi.fn();
		const ctx = createFakeCtx({ ui: { notify } });
		const loop = fake.commands.get("loop")!;

		// notifications.ts resends anything still "pending" (no matching
		// message_end) on agent_settled — confirm each one as it lands, the way
		// pi's real delivery loop does, so agent_settled below tests the loop's
		// own tick-skip logic and not a delivery resend.
		let confirmed = 0;
		const confirmPending = async () => {
			for (; confirmed < fake.sentMessages.length; confirmed++) {
				const details = fake.sentMessages[confirmed].message.details as Record<string, unknown> | undefined;
				if (details?.[NOTIFICATION_ID_KEY]) await fake.fireOne("message_end", { message: { role: "custom", details } });
			}
		};

		await loop.handler("1m check the deploy", ctx);
		await confirmPending();
		// Fires the first iteration immediately.
		expect(fake.sentMessages.filter((m) => m.message.customType === "loop")).toHaveLength(1);
		expect((fake.sentMessages[0].message.content as Array<{ text: string }>)[0].text).toContain("check the deploy");

		// While the agent is mid-turn, a tick must be skipped, not queued.
		await fake.fireOne("agent_start", {});
		await vi.advanceTimersByTimeAsync(60_000);
		await confirmPending();
		expect(fake.sentMessages.filter((m) => m.message.customType === "loop")).toHaveLength(1);

		// Once settled, the next tick fires again.
		await fake.fireOne("agent_settled", {});
		await vi.advanceTimersByTimeAsync(60_000);
		await confirmPending();
		expect(fake.sentMessages.filter((m) => m.message.customType === "loop")).toHaveLength(2);

		await loop.handler("stop", ctx);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sentMessages.filter((m) => m.message.customType === "loop")).toHaveLength(2);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Loop stopped"), "info");
	});
});

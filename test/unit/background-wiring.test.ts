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
import { DEFAULT_COALESCE_MS, NOTIFICATION_ID_KEY } from "../../extensions/lib/notifications.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

function mount(): FakePi {
	const fake = createFakePi();
	backgroundExtension(fake.pi as never);
	// An established session: a prompt() has run, so notifications take the
	// custom-message path (before the first prompt they go out as a user message
	// — createTaskNotifier, STEERING-REVIEW-2026-09-05 H1).
	void fake.fire("before_agent_start", {}, createFakeCtx({}));
	return fake;
}

/**
 * A ctx for a session that outlives the turn (the TUI): the monitor detaches
 * there. The fake's default mode is "print", a one-shot, where the monitor now
 * runs to its end inside the tool call (LIFECYCLE-REVIEW-2026-09-06 M3).
 */
const liveSessionCtx = (overrides: Record<string, unknown> = {}) => createFakeCtx({ hasUI: true, mode: "tui", ...overrides });

describe("background wiring: monitor batching", () => {
	it("flushes a batch (capped, with overflow count) as soon as the command exits", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
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
		// The batch and the completion arrive together, so the notifier merges them
		// into one message after its coalescing window (real timers here).
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));

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
		// Coalesced (STEERING-REVIEW-2026-09-05 M1): one custom message carries both.
		expect(completion).toBe(batchMessage);
		expect(fake.sentMessages).toHaveLength(1);
		// Delivery policy: steered mid-turn, and able to start a turn on its own.
		expect(batchMessage!.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	});

	it("task_stop ends a still-running monitor; task_output then reports it stopped", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
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

		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
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
		await vi.advanceTimersByTimeAsync(120_000 + DEFAULT_COALESCE_MS);
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
		// The first tick is queued at once; the notifier's coalescing window is the only delay.
		await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS);
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
		await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_COALESCE_MS);
		await confirmPending();
		expect(fake.sentMessages.filter((m) => m.message.customType === "loop")).toHaveLength(2);

		await loop.handler("stop", ctx);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sentMessages.filter((m) => m.message.customType === "loop")).toHaveLength(2);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Loop stopped"), "info");
	});
});

/** Mount a fresh instance (the factory re-run after a session swap), start it with a UI, and return its notify mock. */
async function freshSessionNotify(reason: string) {
	const next = createFakePi();
	backgroundExtension(next.pi as never);
	const notify = vi.fn();
	await next.fire("session_start", { reason }, createFakeCtx({ hasUI: true, mode: "tui", ui: { notify } }));
	return notify;
}

describe("background wiring: monitor lifecycle (LIFECYCLE-REVIEW-2026-09-06)", () => {
	it("H1: a monitor whose command ends after session_shutdown repaints nothing, notifies nothing, and never throws", async () => {
		const fake = mount();
		const setWidget = vi.fn();
		const ctx = liveSessionCtx({ ui: { setWidget } });
		const start = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30; echo done", description: "outlives the session" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		expect(setWidget).toHaveBeenCalledTimes(1);
		fake.sentMessages.length = 0;

		await fake.fire("session_shutdown", { reason: "new" }, ctx);
		// From here every getter on the old ctx throws, as pi's does after dispose.
		Object.defineProperty(ctx, "hasUI", {
			get() {
				throw new Error("This extension ctx is stale after session replacement");
			},
		});
		// stopAll SIGTERMed the tree; its `close` lands after shutdown. Wait for it
		// through task_output on a fresh (post-swap) ctx — must not throw either.
		const out = (await fake.tools.get("task_output")!.execute(
			"c2",
			{ task_id: start.details.taskId, block: true, timeout: 5000 },
			undefined,
			undefined,
			createFakeCtx({ mode: "tui" }),
		)) as { details: { status: string } };
		expect(out.details.status).toBe("stopped");
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));
		expect(setWidget).toHaveBeenCalledTimes(1); // no repaint after shutdown
		expect(fake.sentMessages).toHaveLength(0); // no completion notification
	});

	it("M2: task_stop ends the monitored command itself (a `cmd; echo` sequence), so the task finishes at once", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const start = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30; echo done", description: "sequence" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		await new Promise((resolve) => setTimeout(resolve, 100)); // let the shell fork `sleep`
		const stopped = Date.now();
		await fake.tools.get("task_stop")!.execute("c2", { task_id: start.details.taskId }, undefined, undefined, ctx);
		const out = (await fake.tools.get("task_output")!.execute(
			"c3",
			{ task_id: start.details.taskId, block: true, timeout: 5000 },
			undefined,
			undefined,
			ctx,
		)) as { details: { status: string } };
		expect(out.details.status).toBe("stopped");
		// Killing only the shell left `sleep 30` holding the pipe: close came 30 s later.
		expect(Date.now() - stopped).toBeLessThan(3000);
	});

	it("M3: in a one-shot mode the monitor runs to its end and returns the events in the result, registering nothing", async () => {
		const fake = mount();
		const ctx = createFakeCtx({ mode: "print" });
		const result = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "echo ev1; echo ev2; echo ev3", description: "one-shot" },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };
		const text = result.content[0].text;
		expect(text).toContain("completed after 3 event(s)");
		expect(text).toContain("This is a one-shot session, so the monitor ran to completion instead of in the background.");
		expect(text).toContain("ev1\nev2\nev3");
		expect(result.isError).toBeFalsy();
		expect(result.details.taskId).toBeUndefined();
		// Nothing addressable afterwards, and no notification ever queued.
		const lookup = (await fake.tools.get("task_output")!.execute("c2", { task_id: "anything" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(lookup.content[0].text).toContain("Known tasks: (none)");
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));
		expect(fake.sentMessages).toHaveLength(0);
	});

	it("M3: a one-shot monitor stops when the tool call is aborted and says so", async () => {
		const fake = mount();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const result = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30; echo done", description: "aborted" },
			controller.signal,
			undefined,
			createFakeCtx({ mode: "json" }),
		)) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("stopped (tool call aborted) after 0 event(s)");
	});

	it("L3: /clear reports the tasks it stopped in the NEXT session, not the one being torn down", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		const start = (await fake.tools.get("monitor")!.execute(
			"c1",
			{ command: "sleep 30", description: "dev server" },
			undefined,
			undefined,
			ctx,
		)) as { details: { taskId: string } };
		await fake.fire("session_shutdown", { reason: "new" }, ctx);

		// The replacement instance (factories re-run on /clear, findings §8).
		const notify = await freshSessionNotify("new");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain(`Stopped 1 background task with the previous session: ${start.details.taskId} (dev server).`);

		// Consumed: a further session start says nothing.
		expect(await freshSessionNotify("new")).not.toHaveBeenCalled();
	});

	it("L3: a quit leaves no notice behind", async () => {
		const fake = mount();
		const ctx = liveSessionCtx();
		await fake.tools.get("monitor")!.execute("c1", { command: "sleep 30", description: "x" }, undefined, undefined, ctx);
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
		expect(await freshSessionNotify("startup")).not.toHaveBeenCalled();
	});
});

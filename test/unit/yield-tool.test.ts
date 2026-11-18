import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import { TASK_REGISTER_CHANNEL, type BackgroundTask } from "../../extensions/lib/agents/task-registry.ts";
import { NOTIFICATION_HANDED_CHANNEL } from "../../extensions/lib/notify/notifications.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { AGENT_CRON_CHANNEL, type AgentCronRequest } from "../../extensions/lib/agents/agent-cron.ts";
import { SESSION_WORK_CHANNEL, type SessionWorkQuery } from "../../extensions/lib/notify/session-work.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/** The background extension with one running agent task, and the reminders it emits. */
function mount() {
	const fake = createFakePi();
	backgroundExtension(fake.pi as never);
	const task: BackgroundTask = {
		id: "agent001",
		kind: "subagent",
		description: "look up the Stripe connector",
		status: "running",
		startedAt: Date.now(),
		output: () => "",
		stop: () => {},
		finished: new Promise<void>(() => {}),
	};
	fake.events.emit(TASK_REGISTER_CHANNEL, task);
	const reminders: Array<{ text?: string; toolCallId?: string }> = [];
	fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { text?: string; toolCallId?: string }));
	const call = (id: string, ctx = createFakeCtx({ hasUI: true, mode: "tui" })) =>
		fake.tools.get("yield")!.execute(id, {}, undefined, undefined, ctx) as Promise<{ content: Array<{ text: string }>; details: { end: string } }>;
	return { fake, task, reminders, call };
}

describe("the yield tool", () => {
	it("waits while an agent runs, and returns when its report is handed to pi, with the reason on the result", async () => {
		const { fake, task, reminders, call } = mount();
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		let settled = false;
		const wait = call("call_y1").then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(settled).toBe(false);
		task.status = "completed";
		fake.events.emit(NOTIFICATION_HANDED_CHANNEL, { customType: "subagent-result" });
		const result = await wait;
		expect(result.content[0].text).toBe("The wait has ended. The line after this result says why.");
		expect(result.details.end).toBe("delivered");
		expect(reminders).toEqual([{ text: expect.stringMatching(/^Resumed (at once|after \d+ seconds?): something arrived; it follows this line\.$/), toolCallId: "call_y1" }]);
	});

	it("waits once per reply: a second call in the same reply returns at once", async () => {
		const { fake, call } = mount();
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		const controller = new AbortController();
		const first = fake.tools.get("yield")!.execute("call_a", {}, controller.signal, undefined, createFakeCtx({ hasUI: true, mode: "tui" }));
		const second = await call("call_b");
		expect(second.details.end).toBe("duplicate");
		controller.abort();
		await expect(first).resolves.toMatchObject({ details: { end: "interrupted" } });
	});

	it("ends on a message the user queued", async () => {
		const { fake, call } = mount();
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		const result = await call("call_m", createFakeCtx({ hasUI: true, mode: "tui", hasPendingMessages: () => true }));
		expect(result.details.end).toBe("message");
	});

	it("returns at once in a one-shot run, where nothing is in the background", async () => {
		const { fake, call } = mount();
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		const result = await call("call_p", createFakeCtx({ mode: "print" }));
		expect(result.details.end).toBe("nothingRunning");
	});

	it("ends when the session shuts down, so nothing polls a dead session", async () => {
		const { fake, call } = mount();
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		const wait = call("call_s");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await fake.fire("session_shutdown", { type: "session_shutdown" }, createFakeCtx({}));
		await expect(wait).resolves.toMatchObject({ details: { end: "interrupted" } });
	});

	it("counts work another extension reports as running: a busy resident agent or a workflow run", async () => {
		const { fake, task, call } = mount();
		task.status = "completed";
		let busy = true;
		fake.events.on(SESSION_WORK_CHANNEL, (data) => {
			if (busy) (data as SessionWorkQuery).tasks.push({ id: "wf1", type: "workflow", status: "running", description: "review" });
		});
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		const controller = new AbortController();
		let settled = false;
		const wait = (fake.tools.get("yield")!.execute("call_w", {}, controller.signal, undefined, createFakeCtx({ hasUI: true, mode: "tui" })) as Promise<{ details: { end: string } }>).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(settled).toBe(false);
		busy = false;
		await expect(wait).resolves.toMatchObject({ details: { end: "nothingRunning" } });
	});
});

describe("the yield tool and scheduled jobs", () => {
	afterEach(() => vi.useRealTimers());

	it("does not end for a subagent's job, which fires into the agent, not into a new turn here", async () => {
		vi.useFakeTimers({ now: new Date(2026, 10, 18, 12, 0, 30) });
		const { fake, call } = mount();
		await fake.fire("agent_start", {}, createFakeCtx({}));
		fake.events.emit(AGENT_CRON_CHANNEL, { op: "create", agentId: "a1", cwd: "/project", cron: "1 12 * * *", prompt: "agent check", recurring: false } satisfies AgentCronRequest);
		await fake.fire("message_start", { message: { role: "assistant" } }, createFakeCtx({}));
		const controller = new AbortController();
		const wait = fake.tools.get("yield")!.execute("call_c", {}, controller.signal, undefined, createFakeCtx({ hasUI: true, mode: "tui" })) as Promise<{ details: { end: string } }>;
		let end: string | undefined;
		void wait.then((result) => (end = result.details.end));
		await vi.advanceTimersByTimeAsync(120_000);
		expect(end).toBeUndefined();
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(end).toBe("interrupted");
	});
});


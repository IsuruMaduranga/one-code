import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import { TASK_REGISTER_CHANNEL, type BackgroundTask } from "../../extensions/lib/agents/task-registry.ts";
import { agentMessage, createTaskNotifier, TASK_COMPLETION_KEY, TASK_OUTPUT_DELIVERED_CHANNEL, type TaskOutputDelivered, taskNotification } from "../../extensions/lib/notify/notifications.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

function mountTask(kind = "test") {
	const fake = createFakePi();
	backgroundExtension(fake.pi as never);
	let finish!: () => void;
	const task: BackgroundTask = {
		id: "bwait001",
		kind,
		description: "pending work",
		status: "running",
		startedAt: Date.now(),
		output: () => "partial output",
		stop: () => {},
		finished: new Promise<void>((resolve) => { finish = resolve; }),
	};
	fake.events.emit(TASK_REGISTER_CHANNEL, task);
	const ctx = createFakeCtx({ mode: "rpc" });
	const output = (signal?: AbortSignal) => fake.tools.get("task_output")!.execute("call", { task_id: task.id, timeout: 30_000 }, signal, undefined, ctx);
	return { fake, task, finish, output };
}

describe("task_output blocking lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("returns immediately when the tool signal was already aborted", async () => {
		vi.useFakeTimers();
		const { output } = mountTask();
		const controller = new AbortController();
		controller.abort();
		let returned = false;
		const call = output(controller.signal).then(() => { returned = true; });
		await vi.advanceTimersByTimeAsync(0);
		expect(returned).toBe(true);
		await call;
	});

	it("keeps its awaited deadline referenced until the call returns", async () => {
		vi.useFakeTimers();
		const timer = vi.spyOn(globalThis, "setTimeout");
		const { finish, output } = mountTask();
		const call = output();
		const handle = timer.mock.results.at(-1)!.value as NodeJS.Timeout;
		const referenced = handle.hasRef();
		finish();
		await call;
		timer.mockRestore();
		expect(referenced).toBe(true);
	});

	it("removes the losing deadline and abort listener when the task completes", async () => {
		vi.useFakeTimers();
		const { task, finish, output } = mountTask();
		const controller = new AbortController();
		const before = vi.getTimerCount();
		const call = output(controller.signal);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
		task.status = "completed";
		finish();
		await call;
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(before);
	});

	it("removes the abort listener after its deadline returns still-running output", async () => {
		vi.useFakeTimers();
		const { output } = mountTask();
		const controller = new AbortController();
		const call = output(controller.signal);
		await vi.advanceTimersByTimeAsync(30_000);
		const result = await call;
		expect(result).toMatchObject({ details: { status: "running" } });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});

describe("task_output on a background agent", () => {
	afterEach(() => vi.useRealTimers());

	it("returns at once for a running agent, whatever block asks, and says the notification brings the report", async () => {
		vi.useFakeTimers();
		const { output, fake } = mountTask("subagent");
		const asked: string[] = [];
		fake.events.on(TASK_OUTPUT_DELIVERED_CHANNEL, (data) => asked.push((data as TaskOutputDelivered).taskId));
		let returned = false;
		const call = output().then((result) => {
			returned = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(returned).toBe(true);
		const result = (await call) as { content: { text: string }[]; details: { status: string } };
		expect(result.details.status).toBe("running");
		expect(result.content[0].text).toContain("The agent is still running. You will be notified automatically when it completes, with its report");
		expect(result.content[0].text).not.toContain("partial output");
		expect(asked).toEqual([]);
	});

	it("returns a finished agent's report", async () => {
		const { output, task } = mountTask("subagent");
		task.status = "completed";
		const result = (await output()) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("partial output");
	});
});

/**
 * A finished task's output always comes back in task_output's own result:
 * a report must never be lost, and a duplicate is the lesser harm. Each case
 * runs the background extension's task_output beside a producer's notifier on
 * the same bus.
 */
describe("task_output on a finished task returns its output whatever is queued", () => {
	afterEach(() => vi.useRealTimers());
	const text = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
	const sentTexts = (fake: ReturnType<typeof createFakePi>) => fake.sentMessages.map((sent) => (sent.message.content as Array<{ text: string }>)[0].text).join("\n");

	it("with a progress message in pi's queue and the report still in the coalescing batch", async () => {
		vi.useFakeTimers();
		const { fake, task, output } = mountTask("subagent");
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 250, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		notify("subagent-message", agentMessage({ from: task.id, body: "checking one last file" }), { taskId: task.id, name: "reviewer" });
		await vi.advanceTimersByTimeAsync(250);
		expect(fake.sentMessages).toHaveLength(1);
		task.status = "completed";
		task.output = () => "FINAL REPORT: two bugs found";
		notify("subagent-result", taskNotification({ kind: "agent", taskId: task.id, status: "completed", summary: "Agent finished", result: "FINAL REPORT: two bugs found" }), { taskId: task.id, [TASK_COMPLETION_KEY]: true });
		const result = await output();
		expect(text(result)).toContain("FINAL REPORT: two bugs found");
		await vi.advanceTimersByTimeAsync(250);
		// The progress message was delivered; the withdrawn report is not sent again.
		expect(sentTexts(fake)).toContain("checking one last file");
		expect(sentTexts(fake)).not.toContain("FINAL REPORT");
	});

	it("with a spooled shell completion queued in pi: the diagnostics are in the result", async () => {
		const { fake, task, output } = mountTask("bash");
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 0, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		task.status = "failed";
		task.output = () => "BUILD RESULT: 17 tests failed";
		// The spooled completion names the file only, and is already in pi's queue.
		notify("task-notification", taskNotification({ kind: "shell", taskId: task.id, outputFile: "/tmp/s/out.log", status: "failed", summary: "Background command \"npm test\" failed" }), { taskId: task.id, logPath: "/tmp/s/out.log", [TASK_COMPLETION_KEY]: true });
		expect(fake.sentMessages).toHaveLength(1);
		expect(text(await output())).toContain("BUILD RESULT: 17 tests failed");
	});

	it.each(["new", "resume", "fork", "exit"])("when %s comes between the completion and its delivery", async (change) => {
		const { fake, task, output } = mountTask("subagent");
		const notify = createTaskNotifier(fake.pi as never, { coalesceMs: 0, withdrawOnDelivery: true });
		await fake.fire("before_agent_start", {});
		await fake.fire("agent_start", {});
		task.status = "completed";
		task.output = () => "FINAL REPORT: done";
		notify("subagent-result", taskNotification({ kind: "agent", taskId: task.id, status: "completed", summary: "Agent finished", result: "FINAL REPORT: done" }), { taskId: task.id, [TASK_COMPLETION_KEY]: true });
		const result = text(await output());
		// The session goes away before pi delivers the queued completion.
		if (change === "exit") await fake.fire("session_shutdown", { reason: "quit" });
		else await fake.fire("session_start", { reason: change });
		await fake.fire("agent_settled", {});
		expect(result).toContain("FINAL REPORT: done");
		expect(result).not.toMatch(/on its way|will arrive|arrives after this result/);
	});
});


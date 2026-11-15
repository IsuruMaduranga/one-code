import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import { TASK_REGISTER_CHANNEL, type BackgroundTask } from "../../extensions/lib/agents/task-registry.ts";
import { TASK_OUTPUT_DELIVERED_CHANNEL, type TaskOutputDelivered } from "../../extensions/lib/notify/notifications.ts";
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

	it("points at a completion already on its way instead of returning the output a second time", async () => {
		const { output, fake, task } = mountTask("subagent");
		task.status = "completed";
		fake.events.on(TASK_OUTPUT_DELIVERED_CHANNEL, (data) => {
			(data as TaskOutputDelivered).inFlight = true;
		});
		const result = (await output()) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("Its output is already on its way to you as a task notification");
		expect(result.content[0].text).not.toContain("partial output");
	});

	it("returns a finished agent's report when no completion is on its way", async () => {
		const { output, task } = mountTask("subagent");
		task.status = "completed";
		const result = (await output()) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("partial output");
	});
});

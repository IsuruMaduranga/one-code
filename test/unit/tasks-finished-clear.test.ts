import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tasksExtension from "../../extensions/tasks/index.ts";
import { FINISHED_LIST_CLEAR_MS } from "../../extensions/tasks/store.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/**
 * The finished task list (every task completed) clears itself 5 s later, with
 * its widget, the way Claude Code's pinned list does; a new or reopened task
 * cancels the clear, and a one-shot run (no widget) keeps its list.
 */
describe("tasks: the finished list clears after 5 s", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function setup(ctxOverrides: Record<string, unknown> = { mode: "tui", hasUI: true }) {
		const fake = createFakePi();
		tasksExtension(fake.pi as never);
		const ctx = createFakeCtx(ctxOverrides);
		const tool = (name: string) => {
			const t = fake.tools.get(name);
			if (!t) throw new Error(`${name} not registered`);
			return (params: Record<string, unknown>) => t.execute("call", params, undefined, undefined, ctx);
		};
		const list = async () => ((await tool("task_list")({})) as { content: Array<{ text: string }> }).content[0]?.text;
		const setWidget = (ctx.ui as { setWidget: ReturnType<typeof vi.fn> }).setWidget;
		return { fake, ctx, create: tool("task_create"), update: tool("task_update"), list, setWidget };
	}

	it("clears the list and hides the widget 5 s after the last task completes", async () => {
		const t = setup();
		await t.create({ subject: "A", description: "" });
		await t.create({ subject: "B", description: "" });
		await t.update({ taskId: "1", status: "completed" });
		await t.update({ taskId: "2", status: "completed" });
		vi.advanceTimersByTime(FINISHED_LIST_CLEAR_MS - 1);
		expect(await t.list()).toContain("#2");
		vi.advanceTimersByTime(1);
		expect(await t.list()).toBe("No tasks.");
		expect(t.setWidget).toHaveBeenLastCalledWith("cc-tasks", undefined);
		// Ids continue after the clear.
		const created = (await t.create({ subject: "C", description: "" })) as { content: Array<{ text: string }> };
		expect(created.content[0]?.text).toContain("#3");
	});

	it("cancels the clear when a new task arrives first", async () => {
		const t = setup();
		await t.create({ subject: "A", description: "" });
		await t.update({ taskId: "1", status: "completed" });
		vi.advanceTimersByTime(FINISHED_LIST_CLEAR_MS / 2);
		await t.create({ subject: "B", description: "" });
		vi.advanceTimersByTime(FINISHED_LIST_CLEAR_MS * 2);
		expect(await t.list()).toContain("#1");
		expect(await t.list()).toContain("#2");
	});

	it("cancels the clear when a task is reopened first", async () => {
		const t = setup();
		await t.create({ subject: "A", description: "" });
		await t.update({ taskId: "1", status: "completed" });
		await t.update({ taskId: "1", status: "in_progress" });
		vi.advanceTimersByTime(FINISHED_LIST_CLEAR_MS * 2);
		expect(await t.list()).toContain("#1");
	});

	it("keeps the list in a one-shot run, which has no widget", async () => {
		const t = setup({ mode: "print", hasUI: false });
		await t.create({ subject: "A", description: "" });
		await t.update({ taskId: "1", status: "completed" });
		vi.advanceTimersByTime(FINISHED_LIST_CLEAR_MS * 2);
		expect(await t.list()).toContain("#1");
	});

	it("does nothing after session_shutdown", async () => {
		const t = setup();
		await t.create({ subject: "A", description: "" });
		await t.update({ taskId: "1", status: "completed" });
		await t.fake.fire("session_shutdown", {}, t.ctx);
		const widgetCalls = t.setWidget.mock.calls.length;
		vi.advanceTimersByTime(FINISHED_LIST_CLEAR_MS * 2);
		expect(t.setWidget.mock.calls.length).toBe(widgetCalls);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("toggles the list with alt+t and always shows the key", async () => {
		const t = setup();
		const register = t.fake.pi.registerShortcut as ReturnType<typeof vi.fn>;
		const call = register.mock.calls.find(([key]) => key === "alt+t");
		expect(call).toBeDefined();
		const toggle = (call![1] as { handler: (ctx: unknown) => void }).handler;
		const rendered = () => {
			const factory = t.setWidget.mock.calls.at(-1)?.[1] as ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
			return factory ? factory({}, {}).render(120).join("\n") : "";
		};
		await t.create({ subject: "A", description: "" });
		expect(rendered()).toContain("alt+t to hide");
		toggle(t.ctx);
		expect(rendered()).toContain("1 task hidden · alt+t to show");
		expect(rendered()).not.toContain("A");
		toggle(t.ctx);
		expect(rendered()).toContain("alt+t to hide");
	});
});

/**
 * A session switch stops every background task and scheduled job, so it asks
 * first (session_before_switch / session_before_fork can cancel); quitting
 * cannot be cancelled, so the widget line warns while anything runs.
 */
import { describe, expect, it, vi } from "vitest";
import backgroundExtension from "../../extensions/background/index.ts";
import { TASK_REGISTER_CHANNEL, type BackgroundTask } from "../../extensions/background/registry.ts";
import { SWITCH_CANCEL, SWITCH_STOP, switchWarning, workWidgetLine } from "../../extensions/background/switch-guard.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

function fakeTask(id: string, description: string): BackgroundTask & { settle: () => void } {
	let settle!: () => void;
	const finished = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const task = {
		id,
		kind: "bash",
		description,
		status: "running",
		startedAt: Date.now(),
		ownUI: true,
		output: () => "",
		stop: () => {},
		finished,
		settle: () => {
			task.status = "completed";
			settle();
		},
	} as unknown as BackgroundTask & { settle: () => void };
	return task;
}

async function started(ui: Record<string, unknown> = {}, hasUI = true) {
	const fake = createFakePi();
	backgroundExtension(fake.pi as never);
	const ctx = createFakeCtx({ hasUI, mode: "tui", ui });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	return { fake, ctx };
}

describe("switch guard texts", () => {
	it("names what would stop and offers Cancel", () => {
		const text = switchWarning([{ id: "b1", label: "npm run dev" }], [], "Starting a new session")!;
		expect(text).toBe(
			"1 background task is still active. Starting a new session stops it:\n\n  b1  npm run dev\n\nCancel to keep it running; /tasks opens or stops a task.",
		);
	});

	it("counts tasks and jobs together and names at most six", () => {
		const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, label: `task ${i}` }));
		const jobs = Array.from({ length: 3 }, (_, i) => ({ id: `j${i}`, label: "Every 5 minutes" }));
		const text = switchWarning(tasks, jobs, "Forking the session")!;
		expect(text.startsWith("5 background tasks and 3 scheduled jobs are still active. Forking the session stops them:")).toBe(true);
		expect(text).toContain("  j0  Every 5 minutes\n  … and 2 more");
		expect(text).not.toContain("j1");
	});

	it("says nothing when nothing runs", () => {
		expect(switchWarning([], [], "Starting a new session")).toBeUndefined();
		expect(workWidgetLine(0, 0)).toBeUndefined();
	});

	it("the widget line warns about /clear and quitting, and points at /tasks only for tasks", () => {
		expect(workWidgetLine(2, 0)).toBe(" 2 background tasks · stopped by /clear, /reload or quitting · /tasks to manage");
		expect(workWidgetLine(0, 1)).toBe(" 1 scheduled job · stopped by /clear, /reload or quitting");
	});
});

describe("switch guard wiring", () => {
	it("asks before /clear while a task runs; Cancel keeps the session, Stop lets it switch", async () => {
		const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => SWITCH_CANCEL);
		const { fake, ctx } = await started({ select });
		fake.events.emit(TASK_REGISTER_CHANNEL, fakeTask("b1", "npm run dev"));

		expect(await fake.fire("session_before_switch", { reason: "new" }, ctx)).toEqual([{ cancel: true }]);
		expect(select.mock.calls[0][0]).toContain("Starting a new session stops it");
		expect(select.mock.calls[0][1]).toEqual([SWITCH_CANCEL, SWITCH_STOP]);

		select.mockResolvedValueOnce(SWITCH_STOP);
		expect(await fake.fire("session_before_switch", { reason: "resume" }, ctx)).toEqual([undefined]);
		expect(select.mock.calls[1][0]).toContain("Resuming another session stops it");
	});

	it("Escape (no choice) cancels a fork", async () => {
		const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined);
		const { fake, ctx } = await started({ select });
		fake.events.emit(TASK_REGISTER_CHANNEL, fakeTask("b1", "watch"));
		expect(await fake.fire("session_before_fork", { entryId: "e1", position: "at" }, ctx)).toEqual([{ cancel: true }]);
	});

	it("does not ask with nothing running, or without a UI", async () => {
		const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => SWITCH_CANCEL);
		const idle = await started({ select });
		expect(await idle.fake.fire("session_before_switch", { reason: "new" }, idle.ctx)).toEqual([undefined]);

		const headless = await started({ select }, false);
		headless.fake.events.emit(TASK_REGISTER_CHANNEL, fakeTask("b1", "x"));
		expect(await headless.fake.fire("session_before_switch", { reason: "new" }, headless.ctx)).toEqual([undefined]);
		expect(select).not.toHaveBeenCalled();
	});

	it("the widget counts a panel-owned shell while it runs and clears when it finishes", async () => {
		const setWidget = vi.fn();
		const { fake } = await started({ setWidget });
		const task = fakeTask("b1", "npm run dev");
		fake.events.emit(TASK_REGISTER_CHANNEL, task);
		expect(setWidget).toHaveBeenLastCalledWith("cc-background", [" 1 background task · stopped by /clear, /reload or quitting · /tasks to manage"]);
		task.settle();
		await task.finished;
		await Promise.resolve();
		expect(setWidget).toHaveBeenLastCalledWith("cc-background", undefined);
	});
});

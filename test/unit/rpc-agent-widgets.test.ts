import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackgroundTask, TASK_REGISTER_CHANNEL } from "../../extensions/background/registry.ts";
import { trackShellTasks } from "../../extensions/lib/shell-tasks.ts";
import { LiveRunRegistry } from "../../extensions/subagents/live-runs.ts";
import { SubagentWidget } from "../../extensions/subagents/panel-widget.ts";
import type { RunHandle, WorkflowRunManager } from "../../extensions/workflow/run-manager.ts";
import type { ViewerRunSnapshot } from "../../extensions/workflow/viewer.ts";
import { WorkflowWidget } from "../../extensions/workflow/widget.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// pi's RPC setWidget forwards string arrays only; component factories vanish.
function rpcUi() {
	const messages: Array<{ key: string; lines?: string[] }> = [];
	const ctx = {
		mode: "rpc", hasUI: true, isIdle: () => true,
		ui: { setWidget(key: string, content: unknown) {
			if (content === undefined || Array.isArray(content)) messages.push({ key, lines: content as string[] | undefined });
		} },
	} as unknown as ExtensionContext;
	return { ctx, messages };
}

describe("RPC agent status widgets", () => {
	it("sends the subagent strip as text, including status changes and cleanup", () => {
		const rpc = rpcUi();
		const runs = new LiveRunRegistry();
		const widget = new SubagentWidget(runs, () => rpc.ctx);
		runs.register({ taskId: "a1", name: "explore-1", agentType: "explore", task: "Inspect the migration", startedAt: Date.now() });
		vi.advanceTimersByTime(300);
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("explore-1");
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("running");
		runs.finish("a1", false);
		vi.advanceTimersByTime(300);
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("/tasks to see subagents");
		widget.dispose();
		expect(rpc.messages.at(-1)).toEqual({ key: "subagents", lines: undefined });
	});

	it("keeps background shells visible even though they have their own UI", async () => {
		const rpc = rpcUi();
		const fake = createFakePi();
		const shells = trackShellTasks(fake);
		const widget = new SubagentWidget(new LiveRunRegistry(), () => rpc.ctx, shells);
		let finish!: () => void;
		const task: BackgroundTask = {
			id: "shell-1", kind: "bash", description: "Run the build", command: "npm run build",
			status: "running", startedAt: Date.now(), ownUI: true,
			output: () => "", stop: () => {}, finished: new Promise<void>((resolve) => { finish = resolve; }),
		};
		fake.events.emit(TASK_REGISTER_CHANNEL, task);
		vi.advanceTimersByTime(300);
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("shell-1 [shell] running: npm run build");
		task.status = "completed";
		task.finishedAt = Date.now();
		finish();
		await vi.advanceTimersByTimeAsync(300);
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("shell-1 [shell] completed");
		widget.dispose();
	});

	it("sends workflow status as text instead of dropping its component factory", () => {
		const rpc = rpcUi();
		const snapshot = {
			runId: "wf_demo01", name: "Migration review", description: "Review the change",
			status: "running", startedAt: Date.now(), outputTokens: 12, cost: 0,
			agents: [], declaredPhases: [],
		} as ViewerRunSnapshot;
		const manager = { list: () => [snapshot], snapshots: () => [snapshot] } as unknown as WorkflowRunManager;
		const widget = new WorkflowWidget(manager, () => rpc.ctx);
		const handle = new EventEmitter() as RunHandle;
		widget.attach(handle);
		vi.advanceTimersByTime(300);
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("wf_demo01");
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("running");
		snapshot.status = "completed";
		handle.emit("done");
		vi.advanceTimersByTime(300);
		expect(rpc.messages.at(-1)?.lines?.join("\n")).toContain("completed");
		widget.dispose();
	});
});

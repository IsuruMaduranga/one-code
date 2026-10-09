/** Model-free status sources; the widgets and RPC UI adapter are real. */
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import tasksExtension from "../../../extensions/tasks/index.ts";
import { LiveRunRegistry } from "../../../extensions/subagents/live-runs.ts";
import { SubagentWidget } from "../../../extensions/subagents/panel-widget.ts";
import type { RunHandle, WorkflowRunManager } from "../../../extensions/workflow/run-manager.ts";
import type { ViewerRunSnapshot } from "../../../extensions/workflow/viewer.ts";
import { WorkflowWidget } from "../../../extensions/workflow/widget.ts";

export default function rpcWidgetProbe(pi: ExtensionAPI) {
	// Load the real task extension, retaining its tools only to call them from
	// deterministic commands rather than paying for a model to generate calls.
	let createTask: ((ctx: ExtensionContext) => Promise<unknown>) | undefined;
	let completeTask: ((ctx: ExtensionContext) => Promise<unknown>) | undefined;
	tasksExtension({ ...pi, registerTool(tool) {
		pi.registerTool(tool);
		if (tool.name === "task_create") createTask = (ctx) => tool.execute("rpc-create", { subject: "RPC task progress probe", description: "Verify task widget forwarding" } as never, undefined, undefined, ctx as never);
		if (tool.name === "task_update") completeTask = (ctx) => tool.execute("rpc-complete", { taskId: "1", status: "completed" } as never, undefined, undefined, ctx as never);
	} });
	const runs = new LiveRunRegistry();
	const snapshot: ViewerRunSnapshot = {
		runId: "wf_rpcprobe", name: "RPC widget probe", status: "running", startedAt: Date.now(), agents: [],
	};
	const manager = { list: () => [snapshot], snapshots: () => [snapshot] } as unknown as WorkflowRunManager;
	const handle = new EventEmitter() as RunHandle;
	let subagents: SubagentWidget | undefined;
	let workflows: WorkflowWidget | undefined;
	pi.registerCommand("rpc-widget-probe", {
		description: "Test fixture: start model-free agent/workflow status sources",
		handler: async (_args, ctx) => {
			subagents = new SubagentWidget(runs, () => ctx);
			workflows = new WorkflowWidget(manager, () => ctx);
			runs.register({ taskId: "rpc-agent-1", name: "rpc-probe", agentType: "explore", task: "Check the RPC widgets", startedAt: Date.now() });
			workflows.attach(handle);
			await createTask!(ctx);
			await new Promise((resolve) => setTimeout(resolve, 400));
		},
	});
	pi.registerCommand("rpc-widget-finish", {
		description: "Test fixture: finish the model-free status sources",
		handler: async (_args, ctx) => {
			await completeTask!(ctx);
			runs.finish("rpc-agent-1", false);
			snapshot.status = "completed";
			handle.emit("done");
			await new Promise((resolve) => setTimeout(resolve, 400));
		},
	});
	pi.on("session_shutdown", () => { subagents?.dispose(); workflows?.dispose(); });
}

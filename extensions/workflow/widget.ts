/**
 * Live progress panel for workflow runs, rendered with the plain string[]
 * overload of ctx.ui.setWidget. Re-renders are debounced so a chatty fan-out
 * doesn't thrash the TUI; the widget clears itself once no run is active.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunHandle, WorkflowRunManager } from "./run-manager.ts";

const WIDGET_KEY = "workflow";
const DEBOUNCE_MS = 250;
const EVENT_TAIL = 4;

export class WorkflowWidget {
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly manager: WorkflowRunManager,
		private readonly getCtx: () => ExtensionContext | undefined,
	) {}

	attach(handle: RunHandle): void {
		handle.on("progress", () => this.schedule());
		handle.on("done", () => this.schedule());
		this.schedule();
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.render();
		}, DEBOUNCE_MS);
		this.timer.unref?.();
	}

	private render(): void {
		const ctx = this.getCtx();
		if (!ctx?.hasUI) return;
		const active = this.manager.list().filter((h) => h.status === "running");
		if (active.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines: string[] = [];
		for (const handle of active) {
			const state = handle.state;
			const phase = state?.currentPhase();
			const stats = state ? `${state.agentCount()} agents · ${state.outputTokens()} out-tokens` : "starting…";
			lines.push(`⚡ workflow ${handle.meta.name} (${handle.runId}) — ${phase ? `${phase} · ` : ""}${stats}`);
			for (const event of handle.recentEvents.slice(-EVENT_TAIL)) lines.push(`   ${event}`);
		}
		lines.push("   /workflows to inspect · /workflows stop <runId> to stop");
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}
}

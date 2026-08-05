/**
 * Background-task registry (pure) — the id space behind task_output/task_stop.
 *
 * Anything long-running registers here: monitors (owned by this extension) and
 * background subagent runs (registered by the subagents extension over the
 * event bus, since module state does not cross extension boundaries).
 */

import { randomBytes } from "node:crypto";

/** Runtime event-bus channel other extensions use to register their tasks. */
export const TASK_REGISTER_CHANNEL = "pincer:background-task";

export type BackgroundStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTask {
	id: string;
	kind: string;
	description: string;
	status: BackgroundStatus;
	startedAt: number;
	finishedAt?: number;
	/** File the task spools its output to, when it has one. */
	logPath?: string;
	/** Output accumulated so far (or final output once finished). */
	output(): string;
	stop(): void;
	/** Settles when the task reaches a terminal status; never rejects. */
	finished: Promise<void>;
	/**
	 * True while the underlying process outlives the task (a background agent
	 * stays resident after its run so it can be messaged). Lets task_stop
	 * terminate it even though the task itself already completed.
	 */
	resident?: () => boolean;
}

export function generateTaskId(): string {
	return `b${randomBytes(4).toString("hex").slice(0, 7)}`;
}

export class BackgroundRegistry {
	private tasks = new Map<string, BackgroundTask>();

	register(task: BackgroundTask): void {
		if (!task?.id) return;
		this.tasks.set(task.id, task);
	}

	/** Exact id first, then unique prefix match. */
	get(id: string): BackgroundTask | undefined {
		const exact = this.tasks.get(id);
		if (exact) return exact;
		const matches = [...this.tasks.values()].filter((t) => t.id.startsWith(id));
		return matches.length === 1 ? matches[0] : undefined;
	}

	list(): BackgroundTask[] {
		return [...this.tasks.values()];
	}

	running(): BackgroundTask[] {
		return this.list().filter((t) => t.status === "running");
	}

	stopAll(): void {
		for (const task of this.running()) {
			try {
				task.stop();
			} catch {
				// Shutdown must not fail because one task's stop() threw.
			}
		}
	}
}

export function formatTaskLine(task: BackgroundTask): string {
	const age = Math.round((Date.now() - task.startedAt) / 1000);
	const duration = task.finishedAt ? `${Math.round((task.finishedAt - task.startedAt) / 1000)}s` : `${age}s ago`;
	return `${task.id} [${task.kind}] ${task.status} · ${task.description} · started ${duration}`;
}

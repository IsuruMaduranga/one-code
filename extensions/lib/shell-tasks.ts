/**
 * Shell-task tracker — a per-extension live mirror of the background bash
 * shells (kind "bash") that register over TASK_REGISTER_CHANNEL.
 *
 * Module state does not cross extension boundaries (findings §3), but the
 * task OBJECTS do: the bash extension emits each BackgroundTask over the bus,
 * so any consumer holding the reference sees live status/output. Each
 * interested extension (subagents' shell panel, turn-duration) instantiates
 * its own tracker; multiple bus listeners are fine.
 */

import { TASK_REGISTER_CHANNEL, type BackgroundTask } from "../background/registry.ts";

export interface ShellTaskTracker {
	/** Every bash shell registered this session, registration order. */
	list(): BackgroundTask[];
	running(): BackgroundTask[];
	/** Fires on register and on any tracked shell finishing. */
	subscribe(listener: () => void): () => void;
}

interface EventBusLike {
	events: { on(channel: string, handler: (payload: unknown) => void): unknown };
}

export function trackShellTasks(pi: EventBusLike): ShellTaskTracker {
	const tasks = new Map<string, BackgroundTask>();
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// One consumer's render error must not starve the others.
			}
		}
	};
	pi.events.on(TASK_REGISTER_CHANNEL, (payload) => {
		const task = payload as BackgroundTask | undefined;
		if (!task?.id || task.kind !== "bash") return;
		tasks.set(task.id, task);
		notify();
		// `finished` settles (never rejects) per the BackgroundTask contract.
		void task.finished.then(notify);
	});
	return {
		list: () => [...tasks.values()],
		running: () => [...tasks.values()].filter((t) => t.status === "running"),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

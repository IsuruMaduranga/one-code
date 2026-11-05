/**
 * What the task tools need from a profile (types only). The store keeps the
 * tasks and reports what changed as data; the profile words the tools and
 * their results (working-docs/features/profiles/).
 */

import type { TaskItem } from "./store.ts";

/** A task with the blockers it still waits on, as the store sees it now. */
export interface TaskView {
	task: TaskItem;
	openBlockers: readonly string[];
}

/** Why part of an update could not apply (the rest of it did). */
export type UpdateProblem = { kind: "selfReference"; id: string } | { kind: "unknownDependencies"; ids: readonly string[] };

export interface TasksText {
	descriptions: Record<"task_create" | "task_get" | "task_list" | "task_update", string>;
	params: {
		create: Record<"subject" | "description" | "activeForm" | "metadata", string>;
		get: Record<"taskId", string>;
		update: Record<"taskId" | "subject" | "description" | "activeForm" | "status" | "addBlocks" | "addBlockedBy" | "owner" | "metadata", string>;
	};
	/** Search terms for `tool_search`, beyond each tool's name and description. */
	searchKeywords: string[];
	created(task: TaskItem): string;
	details(view: TaskView): string;
	list(views: readonly TaskView[]): string;
	/** No task has this id (as the model wrote it). */
	notFound(rawId: string): string;
	/** `fields`: what changed, in order; `problems`: the parts that did not apply. */
	updated(p: { id: string; fields: readonly string[]; problems: readonly UpdateProblem[] }): string;
	deleted(id: string): string;
	/** The periodic reminder after the task tools go unused, with the current list. */
	reminder(tasks: readonly TaskItem[]): string;
}

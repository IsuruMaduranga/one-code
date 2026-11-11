/**
 * What the task tools need from a profile (types only). The store keeps the
 * tasks and reports what changed as data; the profile words the tools and
 * their results (working-docs/features/profiles/).
 */

import type { TaskItem, TaskStatus } from "./store.ts";

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
}

/** The group's results, refusals and notes, which the base words (`tasksResultText`). */
export interface TasksResultText {
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

/** The status marks task_list shows (the pinned widget has its own, in the base). */
const STATUS_MARK: Record<TaskStatus, string> = { pending: " ", in_progress: "▸", completed: "x" };

function taskLine({ task, openBlockers }: TaskView): string {
	const parts = [`#${task.id} [${STATUS_MARK[task.status]}] ${task.subject}`];
	if (task.owner) parts.push(`owner: ${task.owner}`);
	if (openBlockers.length > 0) parts.push(`blocked by: ${openBlockers.map((b) => `#${b}`).join(", ")}`);
	return parts.join(" · ");
}

function details({ task, openBlockers }: TaskView): string {
	const lines = [
		`Task #${task.id}: ${task.subject}`,
		`Status: ${task.status}${task.owner ? ` · owner: ${task.owner}` : ""}`,
		`Description: ${task.description}`,
	];
	if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map((b) => `#${b}`).join(", ")}`);
	if (task.blockedBy.length > 0) {
		lines.push(`Blocked by: ${task.blockedBy.map((b) => `#${b}`).join(", ")}${openBlockers.length === 0 ? " (all resolved)" : ""}`);
	}
	if (Object.keys(task.metadata).length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
	return lines.join("\n");
}

function problem(p: UpdateProblem): string {
	return p.kind === "selfReference" ? `Task #${p.id} cannot block or be blocked by itself` : `Unknown task id(s) in dependency list: ${p.ids.join(", ")}`;
}

/**
 * The periodic task-tool reminder (Claude Code's `task_reminder`): a single
 * gentle nudge fired when the task tools have gone unused for a while, with the
 * current list appended so the model can clean up completed or stale tasks.
 * Byte-for-byte Claude Code's text except the tool names, which stay our
 * snake_case (working-docs/decisions/tools.md).
 */
function reminder(tasks: readonly TaskItem[]): string {
	let message =
		"The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using task_create to add new tasks and task_update to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n";
	if (tasks.length > 0) {
		const items = tasks.map((t) => `#${t.id}. [${t.status}] ${t.subject}`).join("\n");
		message += `\n\nHere are the existing tasks:\n\n${items}`;
	}
	return message;
}

/** The base's words of the group. */
export const tasksResultText: TasksResultText = {
	created: (task) => `Task #${task.id} created successfully: ${task.subject}`,
	details,
	list: (views) => (views.length === 0 ? "No tasks." : views.map(taskLine).join("\n")),
	notFound: (rawId) => `No task with id "${rawId}". Use task_list to see ids.`,
	// Claude Code's result names the fields that changed.
	updated: ({ id, fields, problems }) => {
		const line = `Updated task #${id} ${fields.join(", ")}`;
		return problems.length > 0 ? `${line}\n${problems.map(problem).join(". ")}` : line;
	},
	deleted: (id) => `Updated task #${id} deleted`,
	reminder,
};

/**
 * tasks extension — Claude Code's stateful Task list:
 * task_create / task_get / task_list / task_update.
 *
 * This is the session's only progress tracker: Claude Code 2.1.233 dropped
 * TodoWrite and made the TaskCreate family its sole todo surface, so our
 * todo_write went with it. Tasks are addressable by id and carry owners,
 * metadata, and dependencies. State rides in tool-result details, so resuming
 * or branching a session restores the list current at that point. All four
 * tools are deferred — discovered via tool_search.
 *
 * The widget mirrors Claude Code's pinned task list (summary line + ✔/◼/◻
 * rows). Claude Code toggles it with ctrl+t, but pi reserves that key for
 * thinking blocks — `/tasks hide` / `/tasks show` covers it instead.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { restoreLatestDetails } from "../lib/branch-restore.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { formatTaskDetails, formatTaskLine, formatTaskList, formatTaskWidget, type TaskSnapshot, TaskStore } from "./store.ts";

interface TaskDetails {
	taskSnapshot: TaskSnapshot;
}

const TASK_TOOLS = new Set(["task_create", "task_get", "task_list", "task_update"]);

export default function tasksExtension(pi: ExtensionAPI) {
	const store = new TaskStore();
	let widgetHidden = false;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const lines = widgetHidden ? [] : formatTaskWidget(store);
		ctx.ui.setWidget("cc-tasks", lines.length > 0 ? lines : undefined);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		const details = restoreLatestDetails<TaskDetails>(ctx.sessionManager.getBranch(), TASK_TOOLS, (d) => Boolean(d?.taskSnapshot));
		store.restore(details?.taskSnapshot);
		updateWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	// Claude Code nudges the model when the task tools have gone unused for a
	// while. A task list nobody remembers to update is decoration, so we do the
	// same — quietly and rarely, based on session state.
	const NUDGE_AFTER_TURNS = 8;
	let turnsSinceTaskUse = 0;

	pi.on("turn_end", () => {
		turnsSinceTaskUse++;
		if (turnsSinceTaskUse < NUDGE_AFTER_TURNS) return;
		turnsSinceTaskUse = 0;

		const tasks = store.list();
		if (tasks.length === 0) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: "The task tools have not been used recently. If the current work has several steps, track it with task_create (load the task tools via tool_search) so progress is visible; skip this if the task is simple.",
			});
			return;
		}

		const active = tasks.filter((t) => t.status === "in_progress");
		const done = tasks.filter((t) => t.status === "completed").length;
		if (active.length === 0 && done < tasks.length) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `The task list has ${tasks.length - done} unfinished task(s) and none marked in_progress. Update it with task_update to reflect what you are actually doing, or delete stale tasks.`,
			});
		} else if (active.length > 1) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `${active.length} tasks are marked in_progress. Exactly one should be in progress at a time — update them with task_update.`,
			});
		}
	});

	const result = (text: string, ctx: ExtensionContext, isError = false) => {
		turnsSinceTaskUse = 0;
		updateWidget(ctx);
		return {
			content: [{ type: "text" as const, text }],
			details: { taskSnapshot: store.snapshot() } satisfies TaskDetails,
			isError,
		};
	};

	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		...ccToolRenderers("Create Task"),
		description:
			"Add a task to the session's structured task list. Tasks are addressable by id and can carry owners, metadata, and dependencies — use task_update to change status or link tasks, task_list/task_get to read them. Create tasks for multi-step work (3+ steps) so progress is visible, and mark exactly one in_progress while working on it.",
		parameters: Type.Object({
			subject: Type.String({ description: "A brief title for the task" }),
			description: Type.String({ description: "What needs to be done" }),
			activeForm: Type.Optional(Type.String({ description: 'Present continuous form shown while in_progress (e.g. "Running tests")' })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata to attach to the task" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = store.create(params);
			return result(`Created task #${task.id}: ${task.subject}`, ctx);
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Get Task",
		...ccToolRenderers("Get Task"),
		description: "Retrieve one task by id: full description, status, owner, and dependency links. Verify blockedBy is empty before starting work on it.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The id of the task to retrieve" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = store.get(params.taskId);
			if (!task) return result(`No task with id "${params.taskId}". Use task_list to see ids.`, ctx, true);
			return result(formatTaskDetails(store, task), ctx);
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		...ccToolRenderers("List Tasks", { maxCollapsedLines: 12 }),
		description: "List all tasks: id, subject, status, owner, and open blockers. Prefer working on unblocked pending tasks in id order.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return result(formatTaskList(store), ctx);
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update Task",
		...ccToolRenderers("Update Task"),
		description:
			"Update a task: status (pending/in_progress/completed, or deleted to remove it), subject, description, owner, metadata (merge; null deletes a key), and dependencies via addBlocks/addBlockedBy. Mark a task in_progress before starting it and completed only when fully done.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The id of the task to update" }),
			status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
			owner: Type.Optional(Type.String({ description: "New owner for the task" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Metadata keys to merge; a null value deletes the key" })),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task ids that cannot start until this one completes" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete before this one" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { taskId, ...input } = params;
			const outcome = store.update(taskId, input as Parameters<TaskStore["update"]>[1]);
			if (outcome.deleted) return result(`Deleted task #${taskId}.`, ctx);
			if (outcome.error && !outcome.task) return result(outcome.error, ctx, true);
			const line = formatTaskLine(store, outcome.task!);
			return result(outcome.error ? `${line}\n${outcome.error}` : line, ctx, Boolean(outcome.error));
		},
	});

	for (const name of TASK_TOOLS) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords: ["task", "todo", "plan", "progress", "dependencies", "tracking"] });
	}

	pi.registerCommand("tasks", {
		description: "Show the structured task list; 'hide'/'show' toggles the widget",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "hide" || arg === "show") {
				widgetHidden = arg === "hide";
				updateWidget(ctx);
				return;
			}
			ctx.ui.notify(formatTaskList(store), "info");
		},
	});
}

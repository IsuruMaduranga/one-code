/**
 * Stateful task list (pure) — Claude Code's TaskCreate/TaskGet/TaskList/TaskUpdate.
 *
 * Tasks are individually addressable by id and carry owners, arbitrary
 * metadata, and dependency links. `blocks` and `blockedBy` are kept
 * reciprocal: adding one side always records the other.
 */

import type { TaskView, UpdateProblem } from "./text.ts";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string;
	metadata: Record<string, unknown>;
	/** Ids of tasks that cannot start until this one completes. */
	blocks: string[];
	/** Ids of tasks that must complete before this one can start. */
	blockedBy: string[];
}

export interface TaskSnapshot {
	nextId: number;
	tasks: TaskItem[];
}

export interface TaskUpdateInput {
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus | "deleted";
	owner?: string;
	metadata?: Record<string, unknown>;
	addBlocks?: string[];
	addBlockedBy?: string[];
}

/** A task id as the model may write it: tasks show as `#3`, so a leading `#` names task 3. */
export function normalizeTaskId(id: string): string {
	return id.startsWith("#") ? id.slice(1) : id;
}

export class TaskStore {
	private tasks = new Map<string, TaskItem>();
	private nextId = 1;

	create(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): TaskItem {
		const task: TaskItem = {
			id: String(this.nextId++),
			subject: input.subject,
			description: input.description,
			activeForm: input.activeForm,
			status: "pending",
			metadata: { ...(input.metadata ?? {}) },
			blocks: [],
			blockedBy: [],
		};
		this.tasks.set(task.id, task);
		return task;
	}

	get(id: string): TaskItem | undefined {
		return this.tasks.get(normalizeTaskId(id));
	}

	list(): TaskItem[] {
		return [...this.tasks.values()];
	}

	/** Ids in `blockedBy` that refer to existing, not-yet-completed tasks. */
	openBlockers(task: TaskItem): string[] {
		return task.blockedBy.filter((id) => {
			const blocker = this.tasks.get(id);
			return blocker !== undefined && blocker.status !== "completed";
		});
	}

	/**
	 * Apply an update. `updatedFields` names what actually changed, in Claude
	 * Code's order (its TaskUpdate result lists them).
	 */
	update(rawId: string, input: TaskUpdateInput): { task?: TaskItem; deleted?: boolean; notFound?: boolean; problems?: UpdateProblem[]; updatedFields?: string[] } {
		const id = normalizeTaskId(rawId);
		const task = this.tasks.get(id);
		if (!task) return { notFound: true };

		if (input.status === "deleted") {
			this.tasks.delete(id);
			for (const other of this.tasks.values()) {
				other.blocks = other.blocks.filter((b) => b !== id);
				other.blockedBy = other.blockedBy.filter((b) => b !== id);
			}
			return { deleted: true };
		}

		const updatedFields: string[] = [];
		if (input.subject !== undefined && input.subject !== task.subject) {
			task.subject = input.subject;
			updatedFields.push("subject");
		}
		if (input.description !== undefined && input.description !== task.description) {
			task.description = input.description;
			updatedFields.push("description");
		}
		if (input.activeForm !== undefined && input.activeForm !== task.activeForm) {
			task.activeForm = input.activeForm;
			updatedFields.push("activeForm");
		}
		if (input.owner !== undefined && (input.owner || undefined) !== task.owner) {
			task.owner = input.owner || undefined;
			updatedFields.push("owner");
		}
		if (input.metadata) {
			for (const [key, value] of Object.entries(input.metadata)) {
				if (value === null) delete task.metadata[key];
				else task.metadata[key] = value;
			}
			updatedFields.push("metadata");
		}
		if (input.status !== undefined && input.status !== task.status) {
			task.status = input.status;
			updatedFields.push("status");
		}

		// Separate a self-reference from a genuinely unknown id: link() rejects
		// both, so folding them together reported a valid, existing id as "Unknown
		// task id" — sending the model to hunt a typo that isn't there.
		const unknown: string[] = [];
		let selfRef = false;
		const blocksBefore = task.blocks.length;
		for (const other of (input.addBlocks ?? []).map(normalizeTaskId)) {
			if (other === id) selfRef = true;
			else if (!this.link(id, other)) unknown.push(other);
		}
		if (task.blocks.length > blocksBefore) updatedFields.push("blocks");
		const blockedByBefore = task.blockedBy.length;
		for (const other of (input.addBlockedBy ?? []).map(normalizeTaskId)) {
			if (other === id) selfRef = true;
			else if (!this.link(other, id)) unknown.push(other);
		}
		if (task.blockedBy.length > blockedByBefore) updatedFields.push("blockedBy");
		const problems: UpdateProblem[] = [];
		if (selfRef) problems.push({ kind: "selfReference", id });
		if (unknown.length > 0) problems.push({ kind: "unknownDependencies", ids: unknown });
		return problems.length > 0 ? { task, problems, updatedFields } : { task, updatedFields };
	}

	/** Record "blocker blocks blocked" on both sides. False if either id is unknown. */
	private link(blockerId: string, blockedId: string): boolean {
		const blocker = this.tasks.get(blockerId);
		const blocked = this.tasks.get(blockedId);
		if (!blocker || !blocked || blockerId === blockedId) return false;
		if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
		if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
		return true;
	}

	snapshot(): TaskSnapshot {
		return { nextId: this.nextId, tasks: this.list().map((t) => ({ ...t, metadata: { ...t.metadata }, blocks: [...t.blocks], blockedBy: [...t.blockedBy] })) };
	}

	/**
	 * A non-empty list with every task completed: the state Claude Code clears
	 * itself from, 5 s after it is reached (`FINISHED_LIST_CLEAR_MS`).
	 */
	isFinished(): boolean {
		const tasks = this.list();
		return tasks.length > 0 && tasks.every((t) => t.status === "completed");
	}

	/**
	 * Drop every task and keep the id counter, as Claude Code's reset does (it
	 * records the high-water mark before deleting), so a task created after a
	 * clear never reuses an id the transcript already mentions.
	 */
	clear(): void {
		this.tasks.clear();
	}

	/**
	 * A finished snapshot restores as empty: the clear runs on a timer and never
	 * lands in a tool result, so without this rule `/resume` or a `/tree` switch
	 * would bring back a list Claude Code would already have cleared.
	 */
	restore(snapshot: TaskSnapshot | undefined): void {
		this.tasks.clear();
		this.nextId = snapshot?.nextId ?? 1;
		for (const task of snapshot?.tasks ?? []) {
			this.tasks.set(task.id, { ...task, metadata: { ...task.metadata }, blocks: [...task.blocks], blockedBy: [...task.blockedBy] });
		}
		if (this.isFinished()) this.clear();
	}
}

/** How long a finished list stays on screen before it clears (Claude Code's 5000 ms). */
export const FINISHED_LIST_CLEAR_MS = 5_000;

/** A task with the blockers it still waits on (text.ts TaskView). */
export function taskView(store: TaskStore, task: TaskItem): TaskView {
	return { task, openBlockers: store.openBlockers(task) };
}

/**
 * Presentation hooks for the widget, injected by the TUI wiring so this
 * module stays pure. The identity default renders plain text (what the unit
 * tests assert against, and what a themeless UI falls back to).
 */
export interface WidgetStyle {
	paint(color: string, text: string): string;
	bold(text: string): string;
	strike(text: string): string;
}

const PLAIN_STYLE: WidgetStyle = { paint: (_color, text) => text, bold: (text) => text, strike: (text) => text };

// TUI counterpart of STATUS_MARK above (the model-facing ASCII in tool
// results) — a new status needs a row style in both places. Colors match the
// ANSI-captured Claude Code widget: green struck-through dim completed rows,
// accent-glyph bold in-progress rows, plain pending rows.
function taskRow(task: TaskItem, { paint, bold, strike }: WidgetStyle): string {
	switch (task.status) {
		case "completed":
			return `${paint("success", "✔")} ${strike(paint("dim", task.subject))}`;
		case "in_progress":
			return `${paint("accent", "◼")} ${bold(task.subject)}`;
		default:
			return `◻ ${task.subject}`;
	}
}

/**
 * The pinned task widget, rendered like Claude Code's: a dim summary line
 * with bold counts ("4 tasks (1 done, 1 in progress, 2 open)") followed by
 * one glyph-prefixed line per task in creation order. Long lists collapse
 * past `maxTasks` so the widget cannot swallow the screen (Claude Code's
 * cutoff is unverified).
 */
export function formatTaskWidget(store: TaskStore, maxTasks = 12, style: WidgetStyle = PLAIN_STYLE, hint?: string): string[] {
	const { paint, bold } = style;
	const tasks = store.list();
	if (tasks.length === 0) return [];
	const done = tasks.filter((t) => t.status === "completed").length;
	const inProgress = tasks.filter((t) => t.status === "in_progress").length;
	const open = tasks.length - done - inProgress;
	const dim = (text: string) => paint("dim", text);
	const count = (n: number) => bold(dim(String(n)));
	const lines = [
		`  ${count(tasks.length)}${dim(` ${tasks.length === 1 ? "task" : "tasks"} (`)}${count(done)}${dim(" done, ")}${count(inProgress)}${dim(" in progress, ")}${count(open)}${dim(" open)")}${hint ? dim(` · ${hint}`) : ""}`,
	];
	for (const t of tasks.slice(0, maxTasks)) lines.push(`  ${taskRow(t, style)}`);
	if (tasks.length > maxTasks) lines.push(`  ${dim(`… +${tasks.length - maxTasks} more`)}`);
	return lines;
}

/**
 * The one line left when the user hides the list, so the key that brings it
 * back stays on screen (Claude Code shows "ctrl+t to show tasks" in its footer).
 */
export function formatHiddenTaskWidget(store: TaskStore, hint: string, style: WidgetStyle = PLAIN_STYLE): string[] {
	const n = store.list().length;
	if (n === 0) return [];
	return [`  ${style.paint("dim", `${n} ${n === 1 ? "task" : "tasks"} hidden · ${hint}`)}`];
}

/**
 * Stateful task list (pure) — Claude Code's TaskCreate/TaskGet/TaskList/TaskUpdate.
 *
 * Tasks are individually addressable by id and carry owners, arbitrary
 * metadata, and dependency links. `blocks` and `blockedBy` are kept
 * reciprocal: adding one side always records the other.
 */

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
		return this.tasks.get(id);
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

	update(id: string, input: TaskUpdateInput): { task?: TaskItem; deleted?: boolean; error?: string } {
		const task = this.tasks.get(id);
		if (!task) return { error: `No task with id "${id}". Use task_list to see ids.` };

		if (input.status === "deleted") {
			this.tasks.delete(id);
			for (const other of this.tasks.values()) {
				other.blocks = other.blocks.filter((b) => b !== id);
				other.blockedBy = other.blockedBy.filter((b) => b !== id);
			}
			return { deleted: true };
		}

		if (input.subject !== undefined) task.subject = input.subject;
		if (input.description !== undefined) task.description = input.description;
		if (input.activeForm !== undefined) task.activeForm = input.activeForm;
		if (input.status !== undefined) task.status = input.status;
		if (input.owner !== undefined) task.owner = input.owner || undefined;

		if (input.metadata) {
			for (const [key, value] of Object.entries(input.metadata)) {
				if (value === null) delete task.metadata[key];
				else task.metadata[key] = value;
			}
		}

		// Separate a self-reference from a genuinely unknown id: link() rejects
		// both, so folding them together reported a valid, existing id as "Unknown
		// task id" — sending the model to hunt a typo that isn't there.
		const unknown: string[] = [];
		let selfRef = false;
		for (const other of input.addBlocks ?? []) {
			if (other === id) selfRef = true;
			else if (!this.link(id, other)) unknown.push(other);
		}
		for (const other of input.addBlockedBy ?? []) {
			if (other === id) selfRef = true;
			else if (!this.link(other, id)) unknown.push(other);
		}
		const errors: string[] = [];
		if (selfRef) errors.push(`Task #${id} cannot block or be blocked by itself`);
		if (unknown.length > 0) errors.push(`Unknown task id(s) in dependency list: ${unknown.join(", ")}`);
		if (errors.length > 0) return { task, error: errors.join(". ") };
		return { task };
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

	restore(snapshot: TaskSnapshot | undefined): void {
		this.tasks.clear();
		this.nextId = snapshot?.nextId ?? 1;
		for (const task of snapshot?.tasks ?? []) {
			this.tasks.set(task.id, { ...task, metadata: { ...task.metadata }, blocks: [...task.blocks], blockedBy: [...task.blockedBy] });
		}
	}
}

const STATUS_MARK: Record<TaskStatus, string> = { pending: " ", in_progress: "▸", completed: "x" };

export function formatTaskLine(store: TaskStore, task: TaskItem): string {
	const parts = [`#${task.id} [${STATUS_MARK[task.status]}] ${task.subject}`];
	if (task.owner) parts.push(`owner: ${task.owner}`);
	const open = store.openBlockers(task);
	if (open.length > 0) parts.push(`blocked by: ${open.map((b) => `#${b}`).join(", ")}`);
	return parts.join(" · ");
}

export function formatTaskList(store: TaskStore): string {
	const tasks = store.list();
	if (tasks.length === 0) return "No tasks.";
	return tasks.map((t) => formatTaskLine(store, t)).join("\n");
}

const WIDGET_MARK: Record<TaskStatus, string> = { pending: "◻", in_progress: "◼", completed: "✔" };

/**
 * The pinned task widget, rendered like Claude Code's: a summary line
 * ("4 tasks (1 done, 1 in progress, 2 open)") followed by one glyph-prefixed
 * line per task in creation order. Long lists collapse past `maxTasks` so the
 * widget cannot swallow the screen (Claude Code's cutoff is unverified).
 */
export function formatTaskWidget(store: TaskStore, maxTasks = 12): string[] {
	const tasks = store.list();
	if (tasks.length === 0) return [];
	const done = tasks.filter((t) => t.status === "completed").length;
	const inProgress = tasks.filter((t) => t.status === "in_progress").length;
	const open = tasks.length - done - inProgress;
	const lines = [`  ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} (${done} done, ${inProgress} in progress, ${open} open)`];
	for (const t of tasks.slice(0, maxTasks)) lines.push(`  ${WIDGET_MARK[t.status]} ${t.subject}`);
	if (tasks.length > maxTasks) lines.push(`  … +${tasks.length - maxTasks} more`);
	return lines;
}

export function formatTaskDetails(store: TaskStore, task: TaskItem): string {
	const lines = [
		`Task #${task.id}: ${task.subject}`,
		`Status: ${task.status}${task.owner ? ` · owner: ${task.owner}` : ""}`,
		`Description: ${task.description}`,
	];
	if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map((b) => `#${b}`).join(", ")}`);
	const open = store.openBlockers(task);
	if (task.blockedBy.length > 0) {
		lines.push(`Blocked by: ${task.blockedBy.map((b) => `#${b}`).join(", ")}${open.length === 0 ? " (all resolved)" : ""}`);
	}
	if (Object.keys(task.metadata).length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
	return lines.join("\n");
}

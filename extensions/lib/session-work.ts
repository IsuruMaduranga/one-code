/**
 * What will wake the session later, for Claude Code's Stop hook payload: its
 * `session_crons` (cron_create jobs, /loop, schedule_wakeup) and
 * `background_tasks` (in-flight background work) fields, findings §21.
 *
 * The hooks extension emits a `SessionWorkQuery` on SESSION_WORK_CHANNEL and
 * reads it back once the synchronous emit returns; the background extension,
 * which owns both lists, fills it (jiti isolation: no shared module state).
 *
 * Pure: no pi imports.
 */

export const SESSION_WORK_CHANNEL = "one-code:session-work";

/** Claude Code's `session_crons` item. */
export interface SessionCron {
	id: string;
	/** The cron expression. */
	schedule: string;
	/** False for one-shots, a wakeup's single fire time included. */
	recurring: boolean;
	prompt: string;
}

/** Claude Code's `background_tasks` item. */
export interface SessionBackgroundTask {
	id: string;
	/** Friendly type label: shell, subagent, monitor, workflow; else the raw kind. */
	type: string;
	status: string;
	description: string;
	/** Only for shell tasks. */
	command?: string;
}

export interface SessionWorkQuery {
	crons: SessionCron[];
	tasks: SessionBackgroundTask[];
}

/** The hook payload's field cap (Claude Code: 1000 characters, then an in-string marker). */
const FIELD_CAP = 1000;

/** Claude Code's clip for these fields: the first 1000 characters, then `… [+N chars]`. */
export function capField(text: string): string {
	return text.length <= FIELD_CAP ? text : `${text.slice(0, FIELD_CAP)}… [+${text.length - FIELD_CAP} chars]`;
}

const TYPE_LABELS: Record<string, string> = { bash: "shell", shell: "shell", agent: "subagent", subagent: "subagent", monitor: "monitor", workflow: "workflow" };

export function sessionCron(job: { id: string; cron: string; recurring: boolean; prompt: string }): SessionCron {
	return { id: job.id, schedule: job.cron, recurring: job.recurring, prompt: capField(job.prompt) };
}

export function sessionBackgroundTask(task: { id: string; kind: string; status: string; description: string; command?: string }): SessionBackgroundTask {
	const type = TYPE_LABELS[task.kind] ?? task.kind;
	return {
		id: task.id,
		type,
		status: task.status,
		description: capField(task.description),
		...(type === "shell" && task.command !== undefined && { command: capField(task.command) }),
	};
}

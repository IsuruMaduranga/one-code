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

import { brandedId } from "../profile/brand.mjs";

export const SESSION_WORK_CHANNEL = brandedId("session-work");

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

/** Background work still running: agents and workflows (Claude Code's pending counts), and every other task (shells, monitors). */
export interface PendingWork {
	agents: number;
	workflows: number;
	others: number;
}

/** What is running now, as the background extension's registry has it (read back after the synchronous emit). */
export function pendingWork(events: { emit(channel: string, data: unknown): void }): PendingWork {
	const query: SessionWorkQuery = { crons: [], tasks: [] };
	events.emit(SESSION_WORK_CHANNEL, query);
	const running = query.tasks.filter((task) => task.status === "running");
	const agents = running.filter((task) => task.type === "subagent").length;
	const workflows = running.filter((task) => task.type === "workflow").length;
	return { agents, workflows, others: running.length - agents - workflows };
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Claude Code 2.1.327's "Waiting for 1 background agent to finish" (findings
 * §94), shown at turn end in place of "Done in Ns" and, here, on the spinner
 * while the model waits in `yield`. Agents and workflows are named; other
 * tasks are counted only when `withOthers` and nothing else runs, so a wait on
 * a shell still says what it waits for. Undefined when nothing it counts runs.
 */
export function waitingForText(pending: PendingWork, withOthers = false): string | undefined {
	const named = [pending.agents > 0 ? counted(pending.agents, "background agent") : "", pending.workflows > 0 ? counted(pending.workflows, "workflow") : ""].filter(Boolean);
	if (named.length === 0 && withOthers && pending.others > 0) named.push(counted(pending.others, "background task"));
	return named.length > 0 ? `Waiting for ${named.join(" and ")} to finish` : undefined;
}

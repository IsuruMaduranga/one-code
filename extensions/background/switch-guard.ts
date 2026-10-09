/**
 * What a session switch or quit would stop (pure). Running background tasks and
 * scheduled jobs belong to the session: `/clear`, `/new`, `/resume` and a fork
 * stop them, and so do `/reload` and quitting. pi lets an extension cancel a
 * switch (`session_before_switch`, `session_before_fork`), so a switch asks
 * first; reloading and quitting have no such hook, so the standing widget line
 * says it up front.
 */

/** A running task or scheduled job, as the dialog and widget name it. */
export interface SessionWork {
	id: string;
	label: string;
}

export const SWITCH_CANCEL = "Cancel";
export const SWITCH_STOP = "Stop them and continue";

/** At most this many items are named in the dialog; the rest are counted. */
const MAX_NAMED = 6;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function counts(tasks: number, jobs: number): string {
	const parts = [tasks > 0 ? plural(tasks, "background task") : "", jobs > 0 ? plural(jobs, "scheduled job") : ""].filter(Boolean);
	return parts.join(" and ");
}

/**
 * The confirm dialog's title, or undefined when nothing would be stopped.
 * `action` names the switch ("Starting a new session"): pi reports /clear and
 * /new alike, so the dialog cannot name the command.
 */
export function switchWarning(tasks: readonly SessionWork[], jobs: readonly SessionWork[], action: string): string | undefined {
	if (tasks.length === 0 && jobs.length === 0) return undefined;
	const items = [...tasks, ...jobs];
	const named = items.slice(0, MAX_NAMED).map((item) => `  ${item.id}  ${item.label}`);
	if (items.length > MAX_NAMED) named.push(`  … and ${items.length - MAX_NAMED} more`);
	const one = items.length === 1;
	const them = one ? "it" : "them";
	return [
		`${counts(tasks.length, jobs.length)} ${one ? "is" : "are"} still active. ${action} stops ${them}:`,
		named.join("\n"),
		tasks.length > 0 ? `Cancel to keep ${them} running; /tasks opens or stops a task.` : `Cancel to keep ${them}.`,
	].join("\n\n");
}

/** The standing widget line while anything runs, or undefined when nothing does. */
export function workWidgetLine(tasks: number, jobs: number): string | undefined {
	if (tasks === 0 && jobs === 0) return undefined;
	return ` ${counts(tasks, jobs)} · stopped by /clear, /reload or quitting${tasks > 0 ? " · /tasks to manage" : ""}`;
}

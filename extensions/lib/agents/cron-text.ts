/**
 * The cron tools' results and refusals, for the main session's tools
 * (tools/background/) and a subagent's proxies (agent-cron.ts) alike. The
 * tools' own words (descriptions and parameters) are the profile's
 * (`CronText`, tools/background/text.ts).
 */
import type { CronText } from "../../tools/background/text.ts";

/** Why cron_create scheduled nothing. */
export type CronCreateFailure =
	| { kind: "invalid"; cron: string }
	/** Parses, but names no date in the next year. */
	| { kind: "neverMatches"; cron: string }
	| { kind: "tooMany"; max: number };

/** A scheduled job as the texts show it. */
export interface ShownJob {
	id: string;
	/** The base's reading of its cron expression, or the expression itself. */
	cadence: string;
	recurring: boolean;
	/** Its prompt, already clipped for a list line. */
	prompt: string;
}

/** The group's results, refusals and notes, which the base words (`cronResultText`). */
export interface CronResultText {
	created(p: { job: ShownJob; maxAgeDays: number }): string;
	createFailed(failure: CronCreateFailure): string;
	list(p: { jobs: ShownJob[] }): string;
	deleted(p: { id: string }): string;
	unknownJob(p: { id: string }): string;
	/** Appended to a scheduling result in a one-shot run, which ends before anything fires. */
	neverFires: string;
	/** A subagent's cron_delete of a job another agent owns. */
	notOwner(p: { id: string }): string;
	/** A subagent's cron_create in a run that ends when its task is done. */
	blockingRunRefusal: string;
	/** A subagent's cron call when the main session's store is not loaded. */
	storeMissing: string;
}

const SESSION_ONLY = "Session-only (not written to disk, dies when this session ends)";

const jobLine = (job: ShownJob) => `${job.id} — ${job.cadence} (${job.recurring ? "recurring" : "one-shot"}) [session-only]: ${job.prompt}`;

function createFailed(failure: CronCreateFailure): string {
	switch (failure.kind) {
		case "invalid":
			return `Invalid cron expression '${failure.cron}'. Expected 5 fields: M H DoM Mon DoW.`;
		case "neverMatches":
			return `Cron expression '${failure.cron}' does not match any calendar date in the next year.`;
		case "tooMany":
			return `Too many scheduled jobs (max ${failure.max}). Cancel one first.`;
	}
}

/** The base's words of the group. */
const cronResultText: CronResultText = {
	created: ({ job, maxAgeDays }) =>
		job.recurring
			? `Scheduled recurring job ${job.id} (${job.cadence}). ${SESSION_ONLY}. Auto-expires after ${maxAgeDays} days. Use cron_delete to cancel sooner.`
			: `Scheduled one-shot task ${job.id} (${job.cadence}). ${SESSION_ONLY}. It will fire once then auto-delete.`,
	createFailed,
	list: ({ jobs }) => (jobs.length ? jobs.map(jobLine).join("\n") : "No scheduled jobs."),
	deleted: ({ id }) => `Cancelled job ${id}.`,
	unknownJob: ({ id }) => `No scheduled job with id '${id}'`,
	neverFires: "This is a one-shot session: it ends when this turn does, so the job will never fire.",
	notOwner: ({ id }) => `Cannot delete cron job '${id}': owned by another agent`,
	blockingRunRefusal:
		"Nothing was scheduled: this agent runs until its task is done and then ends, so a job it schedules could never fire. Do the work now, or report back so the main session can schedule it.",
	storeMissing: "The session's cron store is not loaded; nothing was scheduled.",
};

/** The cron tools' words as their code reads them: the profile's and the base's. */
export type CronWords = CronText & CronResultText;

/** The profile's cron words with the base's results. */
export const cronWords = (profile: CronText): CronWords => ({ ...profile, ...cronResultText });

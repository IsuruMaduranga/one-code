/**
 * What the background extension needs from a profile (types only). The
 * extension decides what happened; the profile words it
 * (working-docs/features/profiles/). The scheduling rules (the limits, the
 * jitter, the clamp) and two formats stay in the base: a cron expression's
 * cadence reading (cron.ts describeCadence) and the list's 80-column prompt
 * clip (clipPrompt), which reach the words as values.
 */

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

/** The cron tools, the main session's and a subagent's proxies alike (lib/agent-cron.ts). */
export interface CronText {
	createDescription(p: { maxAgeDays: number }): string;
	createParams(p: { maxAgeDays: number }): { cron: string; prompt: string; recurring: string; durable: string };
	listDescription: string;
	deleteDescription: string;
	deleteIdParam: string;
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

export type WakeupMissingField = "delayAndReason" | "prompt" | "noop";

export interface WakeupText {
	description: string;
	params: { delaySeconds: string; reason: string; prompt: string; stop: string; noop: string };
	/** `clock` is the local time it fires (HH:MM:SS); `clampedTo` the delay used when the requested one was out of range. */
	scheduled(p: { clock: string; inSeconds: number; clampedTo?: number }): string;
	missing(field: WakeupMissingField): string;
	/** The loop has run its maximum age: nothing was scheduled. */
	agedOut: string;
	stopped(p: { cancelled: number }): string;
}

export interface BackgroundText {
	cron: CronText;
	wakeup: WakeupText;
}

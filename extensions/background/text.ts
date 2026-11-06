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

/** Why a monitor did not start. */
export type MonitorStartFailure =
	/** Neither or both of `command` and `ws` were given. */
	| { kind: "commandOrSocket" }
	/** No bash shell to run the command; `osMessage` says why, when known. */
	| { kind: "noShell"; osMessage?: string }
	| { kind: "socketFailed"; url: string; osMessage: string };

/** How a monitor in a one-shot run ended. */
export type MonitorEnd =
	| { kind: "completed" }
	| { kind: "failed" }
	/** The tool call was aborted. */
	| { kind: "aborted" }
	/** Stopped at its deadline; `persistentAsked` when the call asked for no deadline, which a one-shot run cannot honour. */
	| { kind: "deadline"; ms: number; persistentAsked: boolean };

export interface MonitorText {
	description: string;
	params(p: { defaultTimeoutMs: number; maxTimeoutMs: number }): { command: string; description: string; persistent: string; timeoutMs: string; ws: string };
	startFailed(failure: MonitorStartFailure): string;
	/** A monitor started in the background. */
	started(p: { id: string; description: string }): string;
	/** A one-shot run's monitor, run to its end; `note` is the shared one-shot note, `output` its events or a stand-in. */
	ranToEnd(p: { id: string; description: string; end: MonitorEnd; events: number; note: string; output: string }): string;
	/** A one-shot monitor that saw no event. */
	noEvents: string;
	/** A finished background monitor that saw nothing at all (never a blank, which reads as still running). */
	noOutput: string;
	/** Heads the output when its start is gone: past the in-memory cap with no spool file. */
	spoolLost(p: { keptChars: number }): string;
	/** Heads an in-memory output cut to its last `cap` characters. */
	earlierTruncated: string;
	/** Closes a notification batch that left lines out. */
	moreLines(p: { hidden: number; taskId: string }): string;
}

/** A background task as task_output's header and /background show it. */
export interface ShownTask {
	id: string;
	kind: string;
	status: string;
	description: string;
	/** Seconds it ran, when finished; else seconds since it started. */
	seconds: number;
	finished: boolean;
}

/** task_output and task_stop. */
export interface TaskToolsText {
	outputDescription: string;
	outputParams: { taskId: string; block: string; timeout: string };
	stopDescription: string;
	stopParams: { taskId: string };
	unknownTask(p: { id: string; known: string[] }): string;
	taskLine(task: ShownTask): string;
	noOutputYet: string;
	/** Heads output clipped to its tail; the spool file at `path` has all of it. */
	clippedHeader(p: { path: string }): string;
	alreadyEnded(p: { id: string; status: string }): string;
	/** A finished subagent kept resident for messages, now ended. */
	residentEnded(p: { id: string; description: string }): string;
	stopRequested(p: { id: string; description: string }): string;
}

/** What `/loop <args>` asks for, as the base sorts its arguments (loop-skill.ts loopSkillForm). */
export type LoopSkillForm =
	/** A prompt, with or without an interval: the model parses it. */
	| { kind: "prompt"; input: string }
	/** No prompt: `selfPaced` when no interval was given either; `interval` is the one given, or the default. */
	| { kind: "noPrompt"; selfPaced: boolean; interval: string };

/** A loop-tasks file as read; `truncatedAt` is the cap it was cut to, when it was longer. */
export interface LoopFile {
	path: string;
	content: string;
	truncatedAt?: number;
}

/**
 * The short reminder a fired loop sentinel sends once its full instructions
 * went out: the autonomous loop's (cron or self-paced), or loop.md's (cron,
 * self-paced, or self-paced with the file gone).
 */
export type LoopTick = "autonomous" | "autonomousDynamic" | "loopFile" | "loopFileDynamic" | "loopFileAbsentDynamic";

export interface LoopText {
	/** The /loop skill's body; `persistent` picks the autonomous instructions' persistent variant. */
	skillBody(p: { form: LoopSkillForm; loopFile: LoopFile | null; persistent: boolean; maxAgeDays: number }): string;
	tick(tick: LoopTick): string;
	/** The first fire after loop.md appeared or changed: its tasks, then the tick. */
	loopFileTick(p: { loopFile: LoopFile; tick: string }): string;
	/** The first fire of an autonomous loop: the autonomous-loop instructions (`persistent` picks the variant), then the tick. */
	withPreamble(p: { persistent: boolean; tick: string }): string;
	/** Stands in for folded no-op wakeups in the model's context. */
	foldNote(p: { streak: number }): string;
}

export interface BackgroundText {
	cron: CronText;
	wakeup: WakeupText;
	monitor: MonitorText;
	tasks: TaskToolsText;
	loop: LoopText;
}

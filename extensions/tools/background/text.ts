/**
 * The background tools' words. The extension decides what happened. The
 * profile words the tools themselves and the loop skill (`BackgroundText`:
 * each tool's description and parameters, the loop's body and ticks); the
 * monitor, wake-up and task results are here, the cron results in
 * lib/agents/cron-text.ts, and `backgroundWords` hands the extension both
 * parts per tool family. The scheduling rules (the limits, the
 * jitter, the clamp) and two formats stay in the base: a cron expression's
 * cadence reading (cron.ts describeCadence) and the list's 80-column prompt
 * clip (clipPrompt), which reach the words as values.
 */
import { cronWords } from "../../lib/agents/cron-text.ts";
import { memoOn } from "../../lib/core/text-spans.ts";

/** The cron tools, the main session's and a subagent's proxies alike (lib/agents/agent-cron.ts). */
export interface CronText {
	createDescription(p: { maxAgeDays: number }): string;
	createParams(p: { maxAgeDays: number }): { cron: string; prompt: string; recurring: string; durable: string };
	listDescription: string;
	deleteDescription: string;
	deleteIdParam: string;
}

export type WakeupMissingField = "delayAndReason" | "prompt" | "noop";

export interface WakeupText {
	description: string;
	params: { delaySeconds: string; reason: string; prompt: string; stop: string; noop: string };
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

/** The group's results, refusals and notes, which the base words (`wakeupResultText`). */
export interface WakeupResultText {
	/** `clock` is the local time it fires (HH:MM:SS); `clampedTo` the delay used when the requested one was out of range. */
	scheduled(p: { clock: string; inSeconds: number; clampedTo?: number }): string;
	missing(field: WakeupMissingField): string;
	/** The loop has run its maximum age: nothing was scheduled. */
	agedOut: string;
	stopped(p: { cancelled: number }): string;
}

const MISSING: Record<WakeupMissingField, string> = {
	delayAndReason: "`delaySeconds` and `reason` are required when `stop` is not true.",
	prompt: "`prompt` is required when `stop` is not true.",
	noop: "`noop` is required when `stop` is not true.",
};

/** The base's words of the group. */
export const wakeupResultText: WakeupResultText = {
	scheduled: ({ clock, inSeconds, clampedTo }) => {
		const clamped = clampedTo !== undefined ? ` (clamped to ${clampedTo}s from your requested value)` : "";
		return `Next wakeup scheduled for ${clock} (in ${inSeconds}s)${clamped}. Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`;
	},
	missing: (field) => MISSING[field],
	agedOut: "Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue.",
	stopped: ({ cancelled }) => {
		const monitor = "If you armed a monitor for this loop, task_stop it now; otherwise nothing more to do this turn.";
		if (cancelled === 0)
			return `Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with cron_delete. ${monitor}`;
		return `Loop stopped — cancelled ${cancelled} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${monitor}`;
	},
};

/** The group's results, refusals and notes, which the base words (`monitorResultText`). */
export interface MonitorResultText {
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

function startFailed(failure: MonitorStartFailure): string {
	switch (failure.kind) {
		case "commandOrSocket":
			return "Pass exactly one of `command` or `ws`.";
		case "noShell":
			return `Cannot start the monitor: ${failure.osMessage ?? "no bash shell was found"}`;
		case "socketFailed":
			return `Could not open the WebSocket — check \`ws.url\` ("${failure.url}"): ${failure.osMessage}`;
	}
}

function how(end: MonitorEnd): string {
	switch (end.kind) {
		case "completed":
		case "failed":
			return end.kind;
		case "aborted":
			return "stopped (tool call aborted)";
		case "deadline":
			return end.persistentAsked
				? `stopped at its default deadline of ${end.ms} ms (persistent is not available in a one-shot session)`
				: `stopped at its ${end.ms} ms deadline`;
	}
}

/** The base's words of the group. */
export const monitorResultText: MonitorResultText = {
	startFailed,
	started: ({ id, description }) =>
		`Monitor ${id} started (${description}). Events arrive as task notifications; stop with task_stop, inspect with task_output.`,
	ranToEnd: ({ id, description, end, events, note, output }) => `Monitor ${id} (${description}) ${how(end)} after ${events} event(s). ${note}\n\n${output}`,
	noEvents: "(no events)",
	noOutput: "(no output — the monitor received no events and nothing on stderr)",
	spoolLost: ({ keptChars }) =>
		`[The monitor's spool file could not be written, so only the last ${keptChars.toLocaleString("en-US")} characters of its output were kept.]\n`,
	earlierTruncated: "… (earlier output truncated)\n",
	moreLines: ({ hidden, taskId }) => `\n… +${hidden} more line(s) not shown — task_output ${taskId} has the full stream`,
};

/** The group's results, refusals and notes, which the base words (`taskToolsResultText`). */
export interface TaskToolsResultText {
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

/** The base's words of the group. */
export const taskToolsResultText: TaskToolsResultText = {
	unknownTask: ({ id, known }) => `No background task "${id}". Known tasks: ${known.join(", ") || "(none)"}`,
	taskLine: (task: ShownTask) =>
		`${task.id} [${task.kind}] ${task.status} · ${task.description} · started ${task.finished ? `${task.seconds}s` : `${task.seconds}s ago`}`,
	noOutputYet: "(no output yet)",
	clippedHeader: ({ path }) => `[Truncated. Full output: ${path}]\n\n`,
	alreadyEnded: ({ id, status }) => `Task ${id} is already ${status}.`,
	residentEnded: ({ id, description }) =>
		`Terminated the resident agent behind ${id} (${description}); it can no longer be messaged live (SendMessage will resume it from its session file).`,
	stopRequested: ({ id, description }) => `Stop requested for ${id} (${description}).`,
};

const merge = (profile: BackgroundText) => ({
	cron: cronWords(profile.cron),
	wakeup: { ...profile.wakeup, ...wakeupResultText },
	monitor: { ...profile.monitor, ...monitorResultText },
	tasks: { ...profile.tasks, ...taskToolsResultText },
	loop: profile.loop,
});

/**
 * The background tools' words as the extension reads them: the profile's and
 * the base's, per tool family. One object per profile group, so every reader
 * of a group shares it.
 */
export const backgroundWords = memoOn(merge);

/** The task tools' words, both parts. */
export type TaskToolsWords = TaskToolsText & TaskToolsResultText;

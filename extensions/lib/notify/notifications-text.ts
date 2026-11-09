/**
 * What the shared notification frames (lib/notify/notifications.ts) need from a
 * profile (types only): the words of the agent-message envelope, the task
 * notifications' summaries and notes, the delivery preambles, and the notes
 * that tell the model a session is one-shot or interactive. The tags
 * (`<task-notification>`, `<agent-message>`, `<system-reminder>`) and their
 * order are the base's; it also parses the frames back for display, from the
 * same words.
 */

import type { TaskStatus } from "./notifications.ts";

/** A task notification's `<summary>`. */
export type TaskSummary =
	| { kind: "agent"; name: string; status: TaskStatus; reason?: string }
	/** `detail` explains a failure an exit code does not (a timeout, a signal). */
	| { kind: "shell"; description: string; status: TaskStatus; exitCode: number | null; detail?: string }
	| { kind: "monitorEvent"; description: string }
	/** `produced`: the monitor emitted at least one event. */
	| { kind: "monitorEnded"; description: string; status: TaskStatus; produced: boolean; reason?: string }
	| { kind: "workflow"; name: string; status: TaskStatus; reason?: string };

/** What ran to its end because a one-shot session could not keep it in the background. */
export type OneShotWork = "command" | "workflow" | "agent" | "agentTurn" | "monitor";

export interface NotificationsText {
	agentMessage: {
		/** Opens a message delivered while the session is idle (and every hand-back). */
		opener: string;
		/** Opens a message that lands while the session is mid-turn. */
		openerMidTurn: string;
		/** Closes every agent message: the sender is an agent, not the user. */
		guard: string;
		/** Appended to the guard of a mid-turn message. */
		replyHint: string;
		/** The line above a subagent's indented final report. */
		handBackPreamble: string;
	};
	/** The `<note>` every agent notification carries. */
	agentNote: string;
	/** An agent notification's `<result>` when the report went out as a message from `from`; `flagged` when auto mode's warning sits above it. */
	handBackPointer(p: { from: string; flagged: boolean }): string;
	/** The warning above a flagged hand-back; `reason` is already cut to its limit, `clipped` says whether it was. */
	handBackWarning(p: { kind: "blocked" | "unavailable"; reason: string; clipped: boolean }): string;
	summary(summary: TaskSummary): string;
	/** Above each task notification; `withUserTurn` when it rides a genuine user message. */
	preamble: { alone: string; withUserTurn: string };
	/** Said before a one-shot session's first call. */
	oneShotSession: string;
	/** Said when a session whose first message said one-shot runs interactively. */
	interactiveSession: string;
	/** Heads a result a one-shot session ran to its end. */
	oneShotNote(work: OneShotWork): string;
	/** Inside `<local-command-caveat>`: a local command's breadcrumb is context, not a request. */
	localCommandCaveat: string;
	/** What the user typed at a viewed agent, wrapped for that agent's turn. */
	userMessageMidTurn(p: { text: string }): string;
}

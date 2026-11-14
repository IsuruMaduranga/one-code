/**
 * The child-action log auto mode reviews when a subagent finishes (pure).
 *
 * Claude Code classifies subagent work at three points: the task description
 * before the child starts, each of the child's own actions, and the child's
 * full action history when it returns. The first two fall out of the permission
 * gate — the spawn is classified like any other tool call, and the child
 * inherits auto mode so its actions are classified in its own session.
 *
 * The return check is different in kind: it looks at the *aggregate*. Each step
 * of "read the deploy config, read a token, open a PR" can pass individually
 * while the sequence is what matters. That is only visible once the child is
 * done, which is what this records.
 *
 * The log holds each call's input whole, as Claude Code sends it, with no
 * cap on the number of calls: a clipped command hid its tail from the
 * review, and a count cap hid everything after it. It never holds tool
 * output: output is untrusted content, and feeding it to the classifier is
 * the injection path auto mode exists to close. A run too large for the
 * classifier is not judged, as Claude Code's is not (the review reports it
 * unavailable). The child's final report travels beside the log, because
 * the report is what reaches the parent: the review judges it as the
 * hand-back, framed as untrusted agent output, as Claude Code does
 * (findings §17.2).
 */

import { brandedId } from "../profile/brand.mjs";
import type { HandBackVerdict } from "../notify/notifications.ts";

export const SUBAGENT_ACTIONS_CHANNEL = brandedId("subagent-actions");

export interface ChildAction {
	toolName: string;
	/** The call's input as the model wrote it, whole. Never tool output. */
	input: Record<string, unknown>;
}

export interface SubagentActionsPayload {
	/** The parent's tool call id, so a foreground review attaches to the right result. */
	toolCallId: string;
	actions: ChildAction[];
	/** The child's final report, whole (the parent may get a bounded preview of it): the review's last transcript entry. */
	report: string;
	/**
	 * True for a background/resident run: the spawning call has already returned, so
	 * there is no pending tool_result to attach the hand-back review to. The gate
	 * reviews on receipt and surfaces any concern as its own notification instead.
	 */
	background?: boolean;
	/** Agent name, used to label a background review. */
	agentName?: string;
	/**
	 * Background only: the main session's tool call that started the reviewed
	 * turn (the Agent call, or a later SendMessage), so the review reads the
	 * session as far as that call. A foreground payload's `toolCallId` is that call.
	 */
	startedBy?: string;
	/**
	 * Background only: the gate answers here exactly once — the rendered flag
	 * text when the review raised a concern, undefined when the sequence is
	 * fine or auto mode is off — so the emitter can deliver the verdict with
	 * the completion report rather than as a trailing notice. Answered
	 * synchronously when no review will run, so the emitter never waits for
	 * nothing.
	 */
	onReview?: (verdict: HandBackVerdict | undefined) => void;
}

/** Record one call the child started: its name and a copy of its input. */
export function recordAction(log: ChildAction[], toolName: string, input: unknown): void {
	log.push({ toolName, input: input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {} });
}

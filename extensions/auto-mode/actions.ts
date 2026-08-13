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
 * The log deliberately holds names and short subjects rather than tool output:
 * output is untrusted content, and feeding it to the classifier is the injection
 * path auto mode exists to close.
 */

export const SUBAGENT_ACTIONS_CHANNEL = "one-code:subagent-actions";

export interface ChildAction {
	toolName: string;
	/** Command or path, clipped. Never tool output. */
	subject: string;
}

export interface SubagentActionsPayload {
	/** The parent's tool call id, so a foreground review attaches to the right result. */
	toolCallId: string;
	actions: ChildAction[];
	/**
	 * True for a background/resident run: the spawning call has already returned, so
	 * there is no pending tool_result to attach the holistic review to. The gate
	 * reviews on receipt and surfaces any concern as its own notification instead.
	 */
	background?: boolean;
	/** Agent name, used to label a background review. */
	agentName?: string;
}

/** Per-action and total caps: a long-running child must not blow up the prompt. */
const SUBJECT_LIMIT = 160;
const MAX_ACTIONS = 60;

export function recordAction(log: ChildAction[], toolName: string, input: unknown): void {
	if (log.length >= MAX_ACTIONS) return;
	const args = (input ?? {}) as Record<string, unknown>;
	const raw = args.command ?? args.file_path ?? args.path ?? args.url ?? args.pattern ?? "";
	const subject = typeof raw === "string" ? raw : JSON.stringify(raw);
	log.push({ toolName, subject: subject.slice(0, SUBJECT_LIMIT) });
}

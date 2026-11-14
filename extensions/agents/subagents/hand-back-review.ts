/**
 * The hand-back review of a resident agent's turn, awaited so the verdict
 * travels WITH the completion report instead of trailing it.
 *
 * A resident's spawning call has already returned when its turn ends, so there
 * is no tool_result for the auto-mode gate to attach its review to.
 * Emitting the actions and sending the report immediately (the previous
 * shape) let the "flagged" notice land one or more tool boundaries after the
 * report — the model could act on an agent's output before hearing that auto
 * mode had concerns about how it was produced. Claude Code gates the hand-back
 * (findings §17.2). This module holds the wait: the payload carries an
 * `onReview` callback the gate answers exactly once (a rendered flag, or
 * undefined for clean / not in auto mode), and a timeout bounds the wait so a
 * slow or absent reviewer degrades to "report plus a note", never to a report
 * that waits forever.
 */
import { hasReviewableWork, SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../../lib/rules/auto-mode-actions.ts";
import type { ChildOutcome } from "./outcome.ts";
import type { HandBackVerdict } from "../../lib/notify/notifications.ts";

import { subagentResultText } from "../../lib/agents/subagent-text.ts";
/** How long a completion report waits for the gate's verdict before going out with a note instead. */
export const HAND_BACK_REVIEW_TIMEOUT_MS = 45_000;

/** The verdict that replaces one that did not arrive in time (rendered by `handBackWarning`). */
export const handBackReviewTimeoutVerdict = (): HandBackVerdict => ({ kind: "unavailable", reason: subagentResultText().reviewTimedOut });

/** The events slice this module needs. */
export interface ActionsEmitter {
	emit(channel: string, data: unknown): void;
}

/**
 * Emit a resident turn's actions for review and resolve with the gate's
 * rendered flag (undefined when clean, no actions, or the gate is not in auto
 * mode). Never rejects. The first answer wins; late or repeated answers are
 * ignored.
 */
export function awaitHandBackReview(
	events: ActionsEmitter,
	run: { taskId: string; name: string },
	/** The finished turn: what the child did, and the report it handed back. */
	turn: Pick<ChildOutcome, "actions" | "output">,
	options: {
		timeoutMs?: number;
		/** The main-session call that started the turn (SubagentActionsPayload.startedBy). */
		startedBy?: string;
	} = {},
): Promise<HandBackVerdict | undefined> {
	const { timeoutMs = HAND_BACK_REVIEW_TIMEOUT_MS, startedBy } = options;
	const actions = turn.actions;
	if (!hasReviewableWork({ actions, report: turn.output })) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (verdict: HandBackVerdict | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(verdict);
		};
		const timer = setTimeout(() => finish(handBackReviewTimeoutVerdict()), timeoutMs);
		timer.unref?.();
		events.emit(SUBAGENT_ACTIONS_CHANNEL, {
			toolCallId: run.taskId,
			actions,
			report: turn.output,
			background: true,
			agentName: run.name,
			...(startedBy ? { startedBy } : {}),
			onReview: finish,
		} satisfies SubagentActionsPayload);
	});
}

/**
 * The hand-back review of a resident agent's turn, awaited so the verdict
 * travels WITH the completion report instead of trailing it.
 *
 * A resident's spawning call has already returned when its turn ends, so there
 * is no tool_result for the auto-mode gate to attach its holistic review to.
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
import { SUBAGENT_ACTIONS_CHANNEL, type ChildAction, type SubagentActionsPayload } from "../auto-mode/actions.ts";

/** How long a completion report waits for the gate's verdict before going out with a note instead. */
export const HAND_BACK_REVIEW_TIMEOUT_MS = 45_000;

/** The note that replaces a verdict that did not arrive in time. */
export const HAND_BACK_REVIEW_TIMEOUT_NOTE =
	"<system-reminder>\nAuto mode's review of this agent's actions did not finish before the report was delivered. Treat the output as unverified until you have checked it.\n</system-reminder>";

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
	actions: ChildAction[] | undefined,
	timeoutMs = HAND_BACK_REVIEW_TIMEOUT_MS,
): Promise<string | undefined> {
	if (!actions?.length) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (flag: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(flag);
		};
		const timer = setTimeout(() => finish(HAND_BACK_REVIEW_TIMEOUT_NOTE), timeoutMs);
		timer.unref?.();
		events.emit(SUBAGENT_ACTIONS_CHANNEL, {
			toolCallId: run.taskId,
			actions,
			background: true,
			agentName: run.name,
			onReview: finish,
		} satisfies SubagentActionsPayload);
	});
}

/** Prepend a review flag to a notification body, when there is one. */
export function withReview(body: string, flag: string | undefined): string {
	return flag ? `${flag}\n\n${body}` : body;
}

/**
 * context-budget extension — Claude Code's `<total_tokens>N tokens left</total_tokens>`
 * line, in the three places CC puts it (budget.ts says what the number is):
 *
 * - the end of every user message: the constant budget, a raw `sticky-append`
 *   reminder keyed once per session (`since: 0`, so a resumed session's earlier
 *   user messages carry it too — byte-identical to what they carried before);
 * - every tool result: the countdown, a RAW `last-append` one-shot queued at
 *   `tool_result` time and written into the stored result by system-reminder
 *   (so it persists in the session like CC's and no later request re-caches the
 *   message). That is why this extension sits BEFORE `system-reminder` in the
 *   package manifest — pi runs `tool_result` handlers in load order, and the
 *   block must be queued before system-reminder's handler takes the one-shots.
 *   It emits only at runtime, never at load, so the "listeners load first" rule
 *   for the bus is not at stake;
 * - the system prompt, before the gitStatus block — appended by the
 *   system-prompt extension from the same pure module.
 *
 * A turn starts at the first `agent_start` after a settle (whoever opened it: a
 * prompt or a harness notification) and its baseline is pi's context estimate
 * at that moment. CC_TOTAL_TOKENS=0 turns all three off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REMINDER_CHANNEL, type ReminderPayload } from "../lib/reminders.ts";
import { totalTokensBlock, TurnBudget, turnTokenBudget } from "./budget.ts";

const USER_MESSAGE_KEY = "total-tokens";

export default function contextBudgetExtension(pi: ExtensionAPI) {
	const enabled = () => process.env.CC_TOTAL_TOKENS !== "0";
	const budget = new TurnBudget(turnTokenBudget());
	/** True between the first agent_start of a turn and agent_settled. */
	let busy = false;

	pi.on("session_start", () => {
		busy = false;
		if (!enabled()) return;
		pi.events.emit(REMINDER_CHANNEL, {
			text: totalTokensBlock(budget.budget),
			scope: "every-turn",
			key: USER_MESSAGE_KEY,
			placement: "sticky-append",
			raw: true,
			since: 0,
		} satisfies ReminderPayload);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (busy) return;
		busy = true;
		budget.startTurn(ctx.getContextUsage()?.tokens);
	});
	pi.on("agent_settled", () => {
		busy = false;
	});

	pi.on("tool_result", (_event, ctx) => {
		if (!enabled()) return;
		pi.events.emit(REMINDER_CHANNEL, {
			text: totalTokensBlock(budget.left(ctx.getContextUsage()?.tokens)),
			placement: "last-append",
			raw: true,
		} satisfies ReminderPayload);
	});
}

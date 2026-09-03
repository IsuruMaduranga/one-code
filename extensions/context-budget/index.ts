/**
 * context-budget extension — Claude Code's `<total_tokens>N tokens left</total_tokens>`
 * line after every tool result.
 *
 * Emitted as a RAW `last-append` one-shot on the reminder queue at `tool_result`
 * time: the system-reminder extension writes pending one-shots into the stored
 * result (so the line persists in the session like CC's, and no later request
 * re-caches the message). That is why this extension sits BEFORE
 * `system-reminder` in the package manifest — pi runs `tool_result` handlers in
 * load order, and the block must be queued before system-reminder's handler
 * takes the one-shots. It emits only at runtime, never at load, so the
 * "listeners load first" rule for the bus is not at stake. CC_TOTAL_TOKENS=0
 * turns it off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REMINDER_CHANNEL, type ReminderPayload } from "../lib/reminders.ts";
import { tokensLeft, totalTokensBlock } from "./budget.ts";

export default function contextBudgetExtension(pi: ExtensionAPI) {
	pi.on("tool_result", (_event, ctx) => {
		if (process.env.CC_TOTAL_TOKENS === "0") return;
		const left = tokensLeft(ctx.getContextUsage());
		if (left === undefined) return;
		pi.events.emit(REMINDER_CHANNEL, {
			text: totalTokensBlock(left),
			placement: "last-append",
			raw: true,
		} satisfies ReminderPayload);
	});
}

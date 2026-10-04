/**
 * Claude Code's `SubagentHandback`: the tool every child session (an Agent
 * run, a fork, a workflow agent) returns its result through, and the closing
 * reminder that tells it so (decisions/subagents-workflows.md, "Every child
 * hands back through SubagentHandback"). Claude Code gives it to Opus and
 * Sonnet children only; One Code gives it to every child on every model.
 *
 * The tool records the report in the run's `HandbackSlot` and ends the run
 * (`terminate`, so no further request goes out after a batch of hand-backs).
 * The runner then reports the recorded text as the child's result, and falls
 * back to the child's final message when the tool was never called.
 *
 * The tool keeps Claude Code's exact name, like `Agent` and `SendMessage`,
 * because the harness frames that carry its report already name it ("its
 * SubagentHandback call", lib/notifications.ts). It is harness plumbing: the
 * child permission and hook gates never gate it, and an agent file's `tools`
 * allowlist keeps it.
 *
 * In a fork the tool is deferred: a fork sends the parent's tool list so it
 * reads the parent's prompt cache (subagents/fork-cache.ts), and an eager tool
 * of its own would be dropped from that list. A deferred one reaches the
 * request through a `tool_search` load, as the fork's `SendMessage` does.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "./deferred.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "./reminders.ts";

export const SUBAGENT_HANDBACK = "SubagentHandback";

/** Claude Code's description of the tool. */
export const SUBAGENT_HANDBACK_DESCRIPTION =
	"Deliver your final report to the agent that spawned you (your caller). Use it once, for that hand-off only: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so do everything else first and put everything your caller needs in that one report. It is not a messaging channel: do not use it for progress updates or questions.\n\nOnly a report delivered through SubagentHandback reaches your caller; plain text you write at the end of your run is NOT delivered. There is no recipient parameter: the report can only go to your caller.";

/** Claude Code's closing reminder on the child's task message. */
export const SUBAGENT_HANDBACK_REMINDER =
	"Your final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step. Only a SubagentHandback call reaches your caller as your result; plain text you write at the end is not delivered.";

/**
 * One Code's line before the reminder in a fork, where the tool is deferred
 * (the fork sends its parent's tool list): it names the load step, which the
 * frozen deferred listing it inherits does not.
 */
export const SUBAGENT_HANDBACK_LOAD_FIRST =
	'SubagentHandback is deferred here: load it first with tool_search (query "select:SubagentHandback").';

/** Claude Code's result texts for the call. */
export const HANDBACK_DELIVERED = "Report delivered to your caller.";
export const HANDBACK_ALREADY_DELIVERED =
	"Nothing was sent: your report was already delivered (SubagentHandback delivers one report). Use SendMessage for anything further, then stop.";
export const HANDBACK_EMPTY = "message must not be empty: pass your full report as `message`.";

/** Where a run keeps the report its child handed back. */
export interface HandbackSlot {
	/** Record the report; false when this turn already delivered one. */
	recordHandback(message: string): boolean;
}

/** A slot for a one-turn run (a workflow agent): the first report wins. */
export function oneTurnHandbackSlot(): HandbackSlot & { report?: string } {
	const slot: HandbackSlot & { report?: string } = {
		report: undefined,
		recordHandback(message) {
			if (slot.report !== undefined) return false;
			slot.report = message;
			return true;
		},
	};
	return slot;
}

export function subagentHandbackTool(slot: HandbackSlot): ToolDefinition {
	return {
		name: SUBAGENT_HANDBACK,
		label: "Hand back",
		description: SUBAGENT_HANDBACK_DESCRIPTION,
		parameters: Type.Object({ message: Type.String({ description: "Your full report for your caller" }) }, { additionalProperties: false }) as never,
		async execute(_toolCallId: string, params: unknown) {
			const message = (params as { message?: unknown } | undefined)?.message;
			// Fail loud (decisions/tools.md): an empty report would end the run with nothing for the caller.
			if (typeof message !== "string" || !message.trim()) {
				return { content: [{ type: "text" as const, text: HANDBACK_EMPTY }], details: {}, isError: true };
			}
			if (!slot.recordHandback(message)) {
				return { content: [{ type: "text" as const, text: HANDBACK_ALREADY_DELIVERED }], details: {}, isError: true };
			}
			return { content: [{ type: "text" as const, text: HANDBACK_DELIVERED }], details: { handback: true }, terminate: true };
		},
	} as ToolDefinition;
}

/**
 * The inline extension a child session loads for the hand-back: the tool,
 * deferred in a fork, and the closing reminder. The reminder is a standing
 * block (`sticky-append`) switched on at session start, so it rides the
 * child's task message and every later message of the run (a resident's
 * next turns hand back too), and never an inherited message of a fork.
 */
export function subagentHandbackExtension(slot: HandbackSlot, options: { deferred?: boolean } = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerTool(subagentHandbackTool(slot));
		if (options.deferred) pi.events.emit(DEFER_CHANNEL, { name: SUBAGENT_HANDBACK, keywords: ["handback", "report", "result", "final", "caller"] });
		pi.on("session_start", () => {
			pi.events.emit(REMINDER_CHANNEL, {
				text: options.deferred ? `${SUBAGENT_HANDBACK_LOAD_FIRST}\n${SUBAGENT_HANDBACK_REMINDER}` : SUBAGENT_HANDBACK_REMINDER,
				scope: "every-turn",
				key: "subagent-handback",
				placement: "sticky-append",
			} satisfies ReminderPayload);
		});
	};
}

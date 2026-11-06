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
 * The profile words the tool (lib/handback-text.ts). The tool keeps Claude
 * Code's exact name, like `Agent` and `SendMessage`, because the harness
 * frames that carry its report already name it ("its SubagentHandback
 * call", lib/notifications.ts). It is harness plumbing: the
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
import type { HandbackText } from "./handback-text.ts";
import { requireText } from "./profile.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "./reminders.ts";

export const SUBAGENT_HANDBACK = "SubagentHandback";

/** The profile's words for the tool (fails closed: every child hands back through it). */
const words = (): HandbackText => requireText("handback");

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

/** `sendMessage`: the run also has a SendMessage tool to its caller (a subagent; a workflow agent has none). */
export function subagentHandbackTool(slot: HandbackSlot, sendMessage = false): ToolDefinition {
	const text = words();
	return {
		name: SUBAGENT_HANDBACK,
		label: "Hand back",
		description: text.description,
		parameters: Type.Object({ message: Type.String({ description: text.messageParam }) }, { additionalProperties: false }) as never,
		async execute(_toolCallId: string, params: unknown) {
			const message = (params as { message?: unknown } | undefined)?.message;
			// Fail loud (decisions/tools.md): an empty report would end the run with nothing for the caller.
			if (typeof message !== "string" || !message.trim()) {
				return { content: [{ type: "text" as const, text: text.empty }], details: {}, isError: true };
			}
			if (!slot.recordHandback(message)) {
				return { content: [{ type: "text" as const, text: text.alreadyDelivered({ sendMessage }) }], details: {}, isError: true };
			}
			return { content: [{ type: "text" as const, text: text.delivered }], details: { handback: true }, terminate: true };
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
export function subagentHandbackExtension(slot: HandbackSlot, options: { deferred?: boolean; sendMessage?: boolean } = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerTool(subagentHandbackTool(slot, options.sendMessage));
		if (options.deferred) pi.events.emit(DEFER_CHANNEL, { name: SUBAGENT_HANDBACK, keywords: ["handback", "report", "result", "final", "caller"] });
		pi.on("session_start", () => {
			pi.events.emit(REMINDER_CHANNEL, {
				text: options.deferred ? `${words().loadFirst}\n${words().reminder}` : words().reminder,
				key: "subagent-handback",
				placement: "sticky-append",
			} satisfies ReminderPayload);
		});
	};
}

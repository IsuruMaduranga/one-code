/**
 * Claude Code's per-turn `<total_tokens>` placements (pure). One Code stores
 * the line the way it always has, so a resumed session rebuilds the same
 * bytes: a raw marker block after the text of every user message after the
 * first (context-budget's `sticky-append`), and the countdown as its own
 * block at the end of every tool result (persisted by system-reminder). Two
 * steps turn those into Claude Code's shapes:
 *
 * - at `context` time, while a tool result's blocks are still separate and
 *   keyed by its call id (`resolveCountdowns`): on a model that takes a
 *   mid-conversation system message the countdown block leaves the result and
 *   its value is kept by call id; elsewhere it is framed, a blank line after
 *   the output once pi joins the blocks (Claude Code's Haiku shape);
 * - on the final body (`withTurnBudgetMessages`): on a system-role model a
 *   system message with the line follows each later prompt and each
 *   tool-result message (the lowest countdown it carries), and on first-party
 *   Fable the `clear_at` nudge follows the latter; elsewhere the framed block
 *   goes before the text of each later prompt, with a trailing newline.
 *
 * Nothing is parsed out of joined text, so a tool's own output that contains
 * such a line is never touched.
 */

import { reseatMessageMark } from "./anthropic-payload.ts";
import { wrapReminder } from "./reminders.ts";
import { messagesKey, type SystemRoleLayout, systemMessage, type WireMessage, type WirePart, byWireCallId, withoutParts } from "./system-role.ts";

/** The stored line, exactly. */
const LINE = /^<total_tokens>(\d+) tokens left<\/total_tokens>$/;

/** Claude Code's Fable nudge after a tool result's budget message. */
export const CLEAR_AT_NUDGE =
	"First privately list what you need next; then request every item that doesn't depend on another's result in this one response.";

type StoredBlock = { type?: string; text?: string };
type StoredMessage = { role: string; toolCallId?: string; content?: unknown };

/**
 * The context-time step over pi's messages: each tool result's countdown block
 * (the last whole block that is the line) is lifted out on a system-role model,
 * its value kept under the call id, or framed elsewhere. Returns the messages
 * (the input when nothing changed) and the countdowns by call id.
 */
export function resolveCountdowns<T extends StoredMessage>(messages: T[], systemRole: boolean): { messages: T[]; left: Map<string, number> } {
	const left = new Map<string, number>();
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "toolResult" || !Array.isArray(message.content) || !message.toolCallId) return message;
		const blocks = message.content as StoredBlock[];
		const at = blocks.findLastIndex((block) => block?.type === "text" && typeof block.text === "string" && LINE.test(block.text));
		if (at === -1) return message;
		const line = blocks[at].text as string;
		changed = true;
		if (systemRole) {
			left.set(message.toolCallId, Number(LINE.exec(line)?.[1]));
			return { ...message, content: blocks.filter((_, index) => index !== at) };
		}
		return { ...message, content: blocks.map((block, index) => (index === at ? { ...block, text: `\n${wrapReminder(line)}` } : block)) };
	});
	return { messages: changed ? out : messages, left };
}

export interface TurnBudgetOptions {
	/** The wire shape. */
	shape: SystemRoleLayout;
	/** True on a model that takes a mid-conversation system message. */
	systemRole: boolean;
	/** The role a system message takes on the OpenAI APIs. */
	role: "system" | "developer";
	/** The countdowns `resolveCountdowns` lifted, by call id. */
	left: ReadonlyMap<string, number>;
	/** Send Claude Code's `clear_at` nudge after a tool result's budget message (first-party Fable). */
	nudge?: boolean;
}

/** The call ids a wire message answers: Anthropic `tool_result` blocks, an OpenAI output item or tool message. */
function answeredCalls(message: WireMessage): string[] {
	if (message?.role === "user" && Array.isArray(message.content)) {
		return (message.content as WirePart[]).flatMap((part) => (part?.type === "tool_result" && typeof part.tool_use_id === "string" ? [part.tool_use_id] : []));
	}
	if (message?.type === "function_call_output" && typeof message.call_id === "string") return [message.call_id];
	if (message?.role === "tool" && typeof message.tool_call_id === "string") return [message.tool_call_id];
	return [];
}

export function withTurnBudgetMessages(payload: Record<string, unknown>, opts: TurnBudgetOptions): Record<string, unknown> | undefined {
	const key = messagesKey(opts.shape);
	const messages = payload[key];
	if (!Array.isArray(messages)) return undefined;
	const out: WireMessage[] = [];
	let changed = false;
	/** The lowest countdown of the tool results not yet followed by their message. */
	let pending: number | undefined;
	for (let i = 0; i < messages.length; i++) {
		let message = messages[i] as WireMessage;
		const after: WireMessage[] = [];
		// A later prompt's marker: a system message after it, or the framed block before its text.
		if (message?.role === "user" && Array.isArray(message.content)) {
			const parts = message.content as WirePart[];
			const at = parts.findIndex((part) => typeof part?.text === "string" && LINE.test(part.text));
			// The marker ends the message, so it carries pi's cache mark; withoutParts keeps it.
			const rest = at === -1 ? undefined : withoutParts(parts, (_, index) => index === at);
			if (rest) {
				const line = parts[at].text as string;
				if (opts.systemRole) {
					message = { ...message, content: rest };
					after.push(systemMessage(opts.shape, opts.role, line));
				} else {
					message = { ...message, content: [{ type: opts.shape === "responses" ? "input_text" : "text", text: `${wrapReminder(line)}\n` }, ...rest] };
				}
			}
		}
		if (opts.systemRole) {
			for (const id of answeredCalls(message)) {
				const value = byWireCallId(opts.left, id);
				if (value !== undefined) pending = pending === undefined ? value : Math.min(pending, value);
			}
			// On the OpenAI APIs a batch of results is a run of items; one message follows the run.
			const next = messages[i + 1] as WireMessage | undefined;
			const runContinues = opts.shape !== "anthropic" && (next?.type === "function_call_output" || next?.role === "tool");
			if (pending !== undefined && !runContinues) {
				after.push(systemMessage(opts.shape, opts.role, `<total_tokens>${pending} tokens left</total_tokens>`));
				if (opts.nudge) {
					after.push(opts.shape === "anthropic" ? ({ role: "system", content: CLEAR_AT_NUDGE, clear_at: "next_user_message" } as WireMessage) : systemMessage(opts.shape, opts.role, CLEAR_AT_NUDGE));
				}
				pending = undefined;
			}
		}
		if (message !== messages[i] || after.length > 0) changed = true;
		out.push(message, ...after);
	}
	if (!changed) return undefined;
	return { ...payload, [key]: opts.shape === "anthropic" ? reseatMessageMark(out) : out };
}

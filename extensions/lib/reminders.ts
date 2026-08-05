/**
 * System-reminder queue — the steering mechanism shared by all pi-claude-code
 * extensions. Reminders are injected transiently into the outgoing request via
 * pi's `context` event; they are never written to the session file.
 *
 * Cross-extension contract: emit on the event bus channel
 * `pi-claude-code:system-reminder` with `{ text, scope? }` to enqueue from any
 * extension (including third-party ones). Extensions in this package can also
 * import `reminderQueue` directly.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const REMINDER_CHANNEL = "pi-claude-code:system-reminder";

/** "next-turn" fires once on the next LLM call; "every-turn" fires on every call until removed. */
export type ReminderScope = "next-turn" | "every-turn";

export interface ReminderPayload {
	text?: string;
	scope?: ReminderScope;
	/** Key for every-turn reminders so they can be replaced/removed. */
	key?: string;
	/** Remove the every-turn reminder registered under `key` instead of enqueueing. */
	remove?: boolean;
}

export class ReminderQueue {
	private nextTurn: string[] = [];
	private everyTurn = new Map<string, string>();

	enqueue(text: string, opts?: { scope?: ReminderScope; key?: string }): void {
		if (!text.trim()) return;
		if (opts?.scope === "every-turn") {
			this.everyTurn.set(opts.key ?? text, text);
		} else {
			this.nextTurn.push(text);
		}
	}

	remove(key: string): void {
		this.everyTurn.delete(key);
	}

	/** Returns pending reminders. Clears next-turn reminders; every-turn ones persist. */
	drain(): string[] {
		const drained = [...this.everyTurn.values(), ...this.nextTurn];
		this.nextTurn = [];
		return drained;
	}

	get size(): number {
		return this.everyTurn.size + this.nextTurn.length;
	}
}

/** Shared queue instance for extensions in this package. */
export const reminderQueue = new ReminderQueue();

export function wrapReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Returns a copy of `messages` with reminder blocks appended to the last user
 * message (Claude Code convention: reminders ride inside user-message content
 * blocks). The input array and its messages are not mutated. If there is no
 * user message, the messages are returned unchanged and reminders are dropped
 * by the caller re-enqueueing as needed.
 */
export function injectReminders(messages: AgentMessage[], reminders: string[]): AgentMessage[] {
	if (reminders.length === 0) return messages;

	const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
	if (lastUserIndex === -1) return messages;

	const target = messages[lastUserIndex] as AgentMessage & {
		content: string | (TextContent | ImageContent)[];
	};
	const existing: (TextContent | ImageContent)[] =
		typeof target.content === "string" ? [{ type: "text", text: target.content }] : [...target.content];

	const reminderBlocks: TextContent[] = reminders.map((r) => ({ type: "text", text: wrapReminder(r) }));

	const updated = { ...target, content: [...existing, ...reminderBlocks] };
	const result = [...messages];
	result[lastUserIndex] = updated as AgentMessage;
	return result;
}

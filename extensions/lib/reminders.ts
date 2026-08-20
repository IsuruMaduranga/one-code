/**
 * System-reminder queue — the steering mechanism shared by all One Code
 * extensions. Reminders are injected transiently into the outgoing request via
 * pi's `context` event; they are never written to the session file.
 *
 * Cross-extension contract: emit on the event bus channel
 * `one-code:system-reminder` with `{ text, scope? }` to enqueue from any
 * extension (including third-party ones). Extensions in this package can also
 * import `reminderQueue` directly.
 *
 * Placement mirrors Claude Code's first-user-message reminder stack. Session
 * context reminders (deferred tools, agent catalog, MCP instructions, skills,
 * the `# claudeMd` block) are `first-prepend`: they ride at the front of the
 * FIRST user message, before the user's text, ordered by `order`. Turn-steering
 * reminders (file changed, mode cycled, memory near-limit) are `last-append`:
 * appended to the LAST user message, the Claude Code default. See
 * docs/decisions and the captured payloads (opus-4-8.json / latest-haiku.json).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const REMINDER_CHANNEL = "one-code:system-reminder";

/** "next-turn" fires once on the next LLM call; "every-turn" fires on every call until removed. */
export type ReminderScope = "next-turn" | "every-turn";

/**
 * `first-prepend` → front of the first user message, before the user text,
 * sorted by `order` (Claude Code's context stack). `last-append` → end of the
 * last user message (Claude Code's steering default).
 */
export type ReminderPlacement = "first-prepend" | "last-append";

/**
 * `order` values for the `first-prepend` context stack, matching Claude Code's
 * fixed sequence on the first user message: deferred tools → agent catalog → MCP
 * instructions → skills → the `# claudeMd` block (last, just before the user's
 * text). Gaps leave room for One Code-specific reminders (e.g. subagent models).
 */
export const CONTEXT_ORDER = {
	deferredTools: 10,
	subagentModels: 20,
	agents: 21,
	mcp: 30,
	skills: 40,
	claudeMd: 50,
	// One Code's own instructions ride in their own block AFTER the # claudeMd
	// block (higher `order` = closer to the user text = higher precedence), so
	// ONECODE.md takes precedence over CLAUDE.md. Not part of Claude Code.
	oneCodeMd: 60,
} as const;

/** A drained reminder with everything the injector needs to place it. */
export interface ReminderEntry {
	text: string;
	placement: ReminderPlacement;
	order: number;
	/**
	 * Literal text appended AFTER the closing `</system-reminder>` tag. Claude
	 * Code's `# claudeMd` block ends `</system-reminder>\n\n` on the wire; this
	 * reproduces that byte-for-byte. Defaults to "".
	 */
	suffix?: string;
}

export interface ReminderPayload {
	text?: string;
	scope?: ReminderScope;
	/** Key so a reminder can be replaced (next-turn) or replaced/removed (every-turn). */
	key?: string;
	/** Remove the every-turn reminder registered under `key` instead of enqueueing. */
	remove?: boolean;
	/** Where in the message stack this reminder lands. Defaults to `last-append`. */
	placement?: ReminderPlacement;
	/** Sort key among `first-prepend` reminders (Claude Code order). Defaults to 0. */
	order?: number;
	/** Literal text appended after the closing `</system-reminder>` tag. Defaults to "". */
	suffix?: string;
}

interface StoredReminder extends ReminderEntry {
	key?: string;
}

type EnqueueOptions = {
	scope?: ReminderScope;
	key?: string;
	placement?: ReminderPlacement;
	order?: number;
	suffix?: string;
};

export class ReminderQueue {
	private nextTurn: StoredReminder[] = [];
	private everyTurn = new Map<string, StoredReminder>();

	enqueue(text: string, opts?: EnqueueOptions): void {
		if (!text.trim()) return;
		const entry: StoredReminder = {
			text,
			placement: opts?.placement ?? "last-append",
			order: opts?.order ?? 0,
			suffix: opts?.suffix,
			key: opts?.key,
		};
		if (opts?.scope === "every-turn") {
			this.everyTurn.set(opts.key ?? text, entry);
		} else {
			// A keyed next-turn reminder replaces its predecessor, so a rapidly
			// re-emitted state change (cycling permission modes) announces only
			// where it settled.
			if (opts?.key) this.nextTurn = this.nextTurn.filter((r) => r.key !== opts.key);
			this.nextTurn.push(entry);
		}
	}

	remove(key: string): void {
		this.everyTurn.delete(key);
	}

	/** Returns pending reminders. Clears next-turn reminders; every-turn ones persist. */
	drain(): ReminderEntry[] {
		const drained: ReminderEntry[] = [
			...[...this.everyTurn.values()].map(strip),
			...this.nextTurn.map(strip),
		];
		this.nextTurn = [];
		return drained;
	}

	get size(): number {
		return this.everyTurn.size + this.nextTurn.length;
	}
}

function strip(r: StoredReminder): ReminderEntry {
	return { text: r.text, placement: r.placement, order: r.order, suffix: r.suffix };
}

/** Shared queue instance for extensions in this package. */
export const reminderQueue = new ReminderQueue();

export function wrapReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

type ContentBlock = TextContent | ImageContent;
type UserMessage = AgentMessage & { content: string | ContentBlock[] };

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function reminderBlock(entry: ReminderEntry): TextContent {
	return { type: "text", text: wrapReminder(entry.text) + (entry.suffix ?? "") };
}

/**
 * Returns a copy of `messages` with reminder blocks injected (Claude Code
 * convention: reminders ride inside user-message content blocks). `first-prepend`
 * entries go to the front of the first user message, sorted by `order`, before
 * the user's text; `last-append` entries go to the end of the last user message.
 * A bare string is treated as `last-append` (back-compat). The input array and
 * its messages are not mutated. With no user message, messages are returned
 * unchanged and the caller re-enqueues as needed.
 */
export function injectReminders(
	messages: AgentMessage[],
	reminders: Array<string | ReminderEntry>,
): AgentMessage[] {
	if (reminders.length === 0) return messages;

	const entries: ReminderEntry[] = reminders.map((r) =>
		typeof r === "string" ? { text: r, placement: "last-append", order: 0 } : r,
	);

	const firstPrepend = entries
		.filter((e) => e.placement === "first-prepend")
		.map((e, i) => ({ e, i }))
		.sort((a, b) => a.e.order - b.e.order || a.i - b.i)
		.map((x) => x.e);
	const lastAppend = entries.filter((e) => e.placement === "last-append");

	const firstUserIndex = messages.findIndex((m) => m.role === "user");
	if (firstUserIndex === -1) return messages;
	const lastUserIndex = messages.findLastIndex((m) => m.role === "user");

	const result = [...messages];

	if (firstUserIndex === lastUserIndex) {
		const target = result[firstUserIndex] as UserMessage;
		const blocks = toBlocks(target.content);
		result[firstUserIndex] = {
			...target,
			content: [...firstPrepend.map(reminderBlock), ...blocks, ...lastAppend.map(reminderBlock)],
		} as AgentMessage;
		return result;
	}

	if (firstPrepend.length > 0) {
		const target = result[firstUserIndex] as UserMessage;
		result[firstUserIndex] = {
			...target,
			content: [...firstPrepend.map(reminderBlock), ...toBlocks(target.content)],
		} as AgentMessage;
	}
	if (lastAppend.length > 0) {
		const target = result[lastUserIndex] as UserMessage;
		result[lastUserIndex] = {
			...target,
			content: [...toBlocks(target.content), ...lastAppend.map(reminderBlock)],
		} as AgentMessage;
	}
	return result;
}

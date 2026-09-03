/**
 * System-reminder queue — the steering mechanism shared by all One Code
 * extensions. Reminders are injected transiently into the outgoing request via
 * pi's `context` event; they are never written to the session file.
 *
 * Cross-extension contract: emit on the event bus channel
 * `one-code:system-reminder` with `{ text, scope?, placement? }` to enqueue from
 * any extension (including third-party ones). The queue instance itself lives
 * in the system-reminder extension; do not import one from here (jiti gives
 * every extension its own module instance, so a shared export steers nothing).
 *
 * Three placements, chosen by what kind of fact the reminder is:
 *
 * - `first-prepend` — SESSION CONTEXT that never changes mid-session (deferred
 *   tools, agent catalog, MCP instructions, skills, `# claudeMd`). Front of the
 *   FIRST user message, before the user's text, ordered by `order`, exactly
 *   Claude Code's first-message stack. Byte-stable, so the cached prefix holds.
 * - `sticky-append` — SESSION STATE that switches on and off (auto mode, plan
 *   mode, a worktree session, ultracode). Appended to the user message that
 *   opened the turn during which the state switched on (`since`) and to EVERY
 *   user message after it, so message N carries the block on every later
 *   request too: the prefix stays byte-stable while the state holds, and the
 *   model still sees the reminder on its latest turn. Switching off drops the
 *   blocks (one cache miss, once). The old `last-append` + every-turn
 *   combination re-cached the previous turn on every turn — permanently, in
 *   auto mode.
 * - `last-append` — ONE-SHOT STEERING about what just happened (a deferred tool
 *   miss, a file changed under the model, a mode change). Delivered where the
 *   model reads next, and then KEPT there so the message never changes again:
 *   a one-shot pending when a tool result is stored is written INTO that result
 *   (`takeOneShots` from the `tool_result` hook — Claude Code persists its
 *   mid-turn reminders the same way, so the transcript carries them and no
 *   request ever re-caches the result); a one-shot still pending when a request
 *   goes out is `pin`ned to the request's tail (the trailing tool result by call
 *   id, else the last user message by timestamp) and re-attached to that same
 *   message on every later request, byte-identical. Pins are process memory
 *   (a `--resume` drops them: one miss, once).
 *
 * A compaction summary counts as a user message for anchoring (pi renders it as
 * one), so the context stack survives a compaction that left no user turn.
 *
 * Retry safety falls out of this: pi re-runs the `context` transform per LLM
 * attempt, and both a persisted and a pinned one-shot are present on every
 * attempt by construction.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const REMINDER_CHANNEL = "one-code:system-reminder";

/** "next-turn" fires once on the next LLM call; "every-turn" fires on every call until removed. */
export type ReminderScope = "next-turn" | "every-turn";

/** See the module header for which placement fits which kind of reminder. */
export type ReminderPlacement = "first-prepend" | "sticky-append" | "last-append";

/** Where a delivered one-shot stays: a tool result (by call id) or a user turn (by timestamp). */
export type PinAnchor = { kind: "toolResult"; toolCallId: string } | { kind: "user"; timestamp: number };

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
	/** Tiny-tier-only strict delegation directive, right after the catalog. */
	delegation: 22,
	mcp: 30,
	skills: 40,
	// CLAUDE.md-family (with AGENTS.md as a per-directory fallback when a directory
	// has no CLAUDE.md) — CLAUDE.md > AGENTS.md.
	claudeMd: 50,
	// One Code's own instructions ride in their own block AFTER the # claudeMd
	// block (higher `order` = closer to the user text = higher precedence), so
	// ONECODE.md takes precedence over CLAUDE.md/AGENTS.md. Not part of CC.
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
	/**
	 * `sticky-append` only: when the state switched on. The user message that
	 * opened the turn in progress at that moment, and every user message after
	 * it, carry the block.
	 */
	since?: number;
	/** Set on a pinned one-shot: the exact message it rides on every request. */
	pin?: PinAnchor;
	/**
	 * Emit `text` as-is instead of inside a `<system-reminder>` frame — for the
	 * few Claude Code blocks that ride bare, like `<total_tokens>` after a tool
	 * result. Defaults to false.
	 */
	raw?: boolean;
}

/** Pins kept; the oldest is dropped past this (its message has long scrolled into the cached past anyway). */
const MAX_PINS = 400;

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
	/** Emit the text bare, with no `<system-reminder>` frame. */
	raw?: boolean;
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
	raw?: boolean;
	/** Test seam / explicit anchor for `sticky-append`; defaults to now. */
	since?: number;
};

export class ReminderQueue {
	private nextTurn: StoredReminder[] = [];
	/** Delivered one-shots, each fixed to the message it first rode (see `pin`). */
	private pinned: StoredReminder[] = [];
	private everyTurn = new Map<string, StoredReminder>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	enqueue(text: string, opts?: EnqueueOptions): void {
		if (!text.trim()) return;
		const placement = opts?.placement ?? "last-append";
		const entry: StoredReminder = {
			text,
			placement,
			order: opts?.order ?? 0,
			suffix: opts?.suffix,
			key: opts?.key,
			raw: opts?.raw,
		};
		if (placement === "sticky-append") {
			// A standing reminder re-emitted with the SAME text (plan mode re-emits
			// every turn) keeps its anchor, so the blocks on earlier messages do not
			// move. Different text under the same key is a new fact (plan → auto
			// under the shared "permission-mode" key) and anchors from now.
			const previous = opts?.key !== undefined ? this.everyTurn.get(opts.key) : undefined;
			entry.since =
				opts?.since ??
				(previous?.placement === "sticky-append" && previous.text === text ? previous.since : undefined) ??
				this.now();
		}
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

	/**
	 * Take the pending `last-append` one-shots out of the queue — for the
	 * `tool_result` hook, which writes them into the stored result. Other
	 * placements stay queued for the next request.
	 */
	takeOneShots(): ReminderEntry[] {
		const taken = this.nextTurn.filter((r) => r.placement === "last-append");
		this.nextTurn = this.nextTurn.filter((r) => r.placement !== "last-append");
		return taken.map(strip);
	}

	/**
	 * Fix the pending `last-append` one-shots to `anchor` — the message they ride
	 * on this request — so every later request re-attaches them there unchanged.
	 * Called by the owner at `context` time, after it has decided the tail.
	 */
	pin(anchor: PinAnchor): void {
		for (const entry of this.nextTurn) {
			if (entry.placement !== "last-append") continue;
			this.pinned.push({ ...entry, pin: anchor });
		}
		this.nextTurn = this.nextTurn.filter((r) => r.placement !== "last-append");
		if (this.pinned.length > MAX_PINS) this.pinned.splice(0, this.pinned.length - MAX_PINS);
	}

	/** Everything to inject on this request: every-turn state, pinned one-shots, then whatever is still pending. */
	drain(): ReminderEntry[] {
		const pending = this.nextTurn.map(strip);
		this.nextTurn = [];
		return [...[...this.everyTurn.values()].map(strip), ...this.pinned.map(strip), ...pending];
	}

	get size(): number {
		return this.everyTurn.size + this.nextTurn.length + this.pinned.length;
	}

	/** True when a one-shot is waiting to be delivered (the owner decides where). */
	get hasPendingOneShots(): boolean {
		return this.nextTurn.some((r) => r.placement === "last-append");
	}
}

function strip(r: StoredReminder): ReminderEntry {
	const entry: ReminderEntry = { text: r.text, placement: r.placement, order: r.order, suffix: r.suffix };
	if (r.raw) entry.raw = true;
	if (r.since !== undefined) entry.since = r.since;
	if (r.pin !== undefined) entry.pin = r.pin;
	return entry;
}

/** The anchor a one-shot lands on for this request: the trailing tool result, else the last user-like message. */
export function tailAnchor(messages: AgentMessage[]): PinAnchor | undefined {
	const last = messages[messages.length - 1] as (AgentMessage & { toolCallId?: string }) | undefined;
	if (last?.role === "toolResult" && typeof last.toolCallId === "string") return { kind: "toolResult", toolCallId: last.toolCallId };
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as AgentMessage & { timestamp?: number };
		if ((m.role === "user" || m.role === "compactionSummary") && typeof m.timestamp === "number") {
			return { kind: "user", timestamp: m.timestamp };
		}
	}
	return undefined;
}

/** A tool result's content with reminder blocks appended (for the `tool_result` hook). */
export function appendReminderBlocks(content: ContentBlock[], entries: ReminderEntry[]): ContentBlock[] {
	return [...content, ...entries.map(reminderBlock)];
}

export function wrapReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * pi's `convertToLlm` renders a `compactionSummary` message as a user message
 * with exactly this frame (`core/messages.js`, not exported through the
 * package's exports map — copied here and locked by a unit test). Used when a
 * reminder must anchor to the summary because no user turn survived compaction.
 */
export const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

type ContentBlock = TextContent | ImageContent;

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function reminderBlock(entry: ReminderEntry): TextContent {
	return { type: "text", text: (entry.raw ? entry.text : wrapReminder(entry.text)) + (entry.suffix ?? "") };
}

/** Roles a reminder block can be attached to. */
function isUserLike(m: AgentMessage): boolean {
	return m.role === "user" || m.role === "compactionSummary";
}

/** A copy of `message` with `before` blocks in front of its content and `after` blocks behind. */
function withBlocks(message: AgentMessage, before: TextContent[], after: TextContent[]): AgentMessage {
	if (before.length === 0 && after.length === 0) return message;
	if (message.role === "compactionSummary") {
		const summary = message as unknown as { summary: string; timestamp: number };
		return {
			role: "user",
			content: [
				...before,
				{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary.summary + COMPACTION_SUMMARY_SUFFIX },
				...after,
			],
			timestamp: summary.timestamp,
		} as AgentMessage;
	}
	const target = message as AgentMessage & { content: string | ContentBlock[] };
	return { ...target, content: [...before, ...toBlocks(target.content), ...after] } as AgentMessage;
}

/**
 * Returns a copy of `messages` with reminder blocks injected (Claude Code
 * convention: reminders ride inside message content blocks, never as messages
 * of their own). See the module header for the three placements. A bare string
 * is `last-append` (back-compat). The input array and its messages are not
 * mutated. With nothing to anchor to (no user, tool-result, or compaction
 * summary message), messages are returned unchanged and the caller keeps the
 * reminders queued.
 */
export function injectReminders(messages: AgentMessage[], reminders: Array<string | ReminderEntry>): AgentMessage[] {
	if (reminders.length === 0) return messages;

	const entries: ReminderEntry[] = reminders.map((r) =>
		typeof r === "string" ? { text: r, placement: "last-append", order: 0 } : r,
	);
	const firstPrepend = entries
		.filter((e) => e.placement === "first-prepend")
		.map((e, i) => ({ e, i }))
		.sort((a, b) => a.e.order - b.e.order || a.i - b.i)
		.map((x) => x.e);
	const sticky = entries.filter((e) => e.placement === "sticky-append");
	const pinnedEntries = entries.filter((e) => e.pin !== undefined);
	const lastAppend = entries.filter((e) => e.placement === "last-append" && e.pin === undefined);

	const firstUserIndex = messages.findIndex(isUserLike);
	const lastUserIndex = messages.findLastIndex(isUserLike);
	const lastIndex = messages.length - 1;
	// Mid-turn, the request ends in the tool result(s) the model is about to
	// read — that is where a one-shot reminder belongs. Otherwise the last user turn.
	const tailIndex = lastIndex >= 0 && messages[lastIndex].role === "toolResult" ? lastIndex : lastUserIndex;
	if (firstUserIndex === -1 && tailIndex === -1) return messages;

	const before = new Map<number, TextContent[]>();
	const after = new Map<number, TextContent[]>();
	const push = (map: Map<number, TextContent[]>, index: number, blocks: TextContent[]) => {
		if (index < 0 || blocks.length === 0) return;
		map.set(index, [...(map.get(index) ?? []), ...blocks]);
	};

	push(before, firstUserIndex === -1 ? tailIndex : firstUserIndex, firstPrepend.map(reminderBlock));

	for (const entry of sticky) {
		const since = entry.since ?? 0;
		// The block rides the user message that opened the turn during which the
		// state switched on (the latest user message stamped before `since` — a
		// standing reminder emitted on before_agent_start is always stamped after
		// the turn's user message) and every user message after it. The set only
		// grows while the state holds, so earlier messages never change.
		let opener = -1;
		const carriers: number[] = [];
		messages.forEach((m, index) => {
			if (m.role !== "user") return;
			const stamp = (m as { timestamp?: number }).timestamp ?? 0;
			if (stamp >= since) carriers.push(index);
			else opener = index;
		});
		if (opener !== -1) carriers.unshift(opener);
		if (carriers.length === 0) {
			// No user turn at all (overflow compaction mid-turn): ride the tail.
			push(after, tailIndex === -1 ? firstUserIndex : tailIndex, [reminderBlock(entry)]);
			continue;
		}
		for (const index of carriers) push(after, index, [reminderBlock(entry)]);
	}

	push(after, tailIndex === -1 ? firstUserIndex : tailIndex, lastAppend.map(reminderBlock));

	// Pinned one-shots ride the exact message they first landed on; a message
	// compacted away simply no longer carries its pin.
	for (const entry of pinnedEntries) {
		const pin = entry.pin as PinAnchor;
		const index = messages.findIndex((m) =>
			pin.kind === "toolResult"
				? m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === pin.toolCallId
				: (m.role === "user" || m.role === "compactionSummary") && (m as { timestamp?: number }).timestamp === pin.timestamp,
		);
		if (index !== -1) push(after, index, [reminderBlock(entry)]);
	}

	if (before.size === 0 && after.size === 0) return messages;
	return messages.map((m, index) => withBlocks(m, before.get(index) ?? [], after.get(index) ?? []));
}

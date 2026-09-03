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
 *   miss, a file changed under the model, a mode change). Appended to the
 *   trailing tool result when one closes the request (that is where Claude Code
 *   puts mid-turn reminders: on the result the model is about to read), else to
 *   the last user message.
 *
 * A compaction summary counts as a user message for anchoring (pi renders it as
 * one), so the context stack survives a compaction that left no user turn.
 *
 * Delivery: `drain()` hands out next-turn entries but keeps them in flight until
 * `commit()` (the owner calls it once an assistant message actually lands). pi
 * re-runs the `context` transform per LLM attempt, so a 429/529 retry re-drains
 * and the model that finally answers still sees them.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const REMINDER_CHANNEL = "one-code:system-reminder";

/** "next-turn" fires once on the next LLM call; "every-turn" fires on every call until removed. */
export type ReminderScope = "next-turn" | "every-turn";

/** See the module header for which placement fits which kind of reminder. */
export type ReminderPlacement = "first-prepend" | "sticky-append" | "last-append";

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
	/** Test seam / explicit anchor for `sticky-append`; defaults to now. */
	since?: number;
};

export class ReminderQueue {
	private nextTurn: StoredReminder[] = [];
	/** Drained next-turn entries not yet confirmed delivered (see `commit`). */
	private inFlight: StoredReminder[] = [];
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
			if (opts?.key) {
				this.nextTurn = this.nextTurn.filter((r) => r.key !== opts.key);
				this.inFlight = this.inFlight.filter((r) => r.key !== opts.key);
			}
			this.nextTurn.push(entry);
		}
	}

	remove(key: string): void {
		this.everyTurn.delete(key);
	}

	/**
	 * Returns pending reminders: every-turn ones, then next-turn ones (those
	 * still in flight from a previous drain first). Next-turn entries stay in
	 * flight until `commit()`, so a retried request re-delivers them.
	 */
	drain(): ReminderEntry[] {
		this.inFlight = [...this.inFlight, ...this.nextTurn];
		this.nextTurn = [];
		return [...[...this.everyTurn.values()].map(strip), ...this.inFlight.map(strip)];
	}

	/** An assistant message landed for the last drained request: its next-turn reminders were delivered. */
	commit(): void {
		this.inFlight = [];
	}

	get size(): number {
		return this.everyTurn.size + this.nextTurn.length + this.inFlight.length;
	}
}

function strip(r: StoredReminder): ReminderEntry {
	const entry: ReminderEntry = { text: r.text, placement: r.placement, order: r.order, suffix: r.suffix };
	if (r.since !== undefined) entry.since = r.since;
	return entry;
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
	return { type: "text", text: wrapReminder(entry.text) + (entry.suffix ?? "") };
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
	const lastAppend = entries.filter((e) => e.placement === "last-append");

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

	if (before.size === 0 && after.size === 0) return messages;
	return messages.map((m, index) => withBlocks(m, before.get(index) ?? [], after.get(index) ?? []));
}

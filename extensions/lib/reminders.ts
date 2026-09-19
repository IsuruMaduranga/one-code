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
 * - `user-prepend` — LOCAL-COMMAND BREADCRUMBS (`/clear`, `/model`, a panel
 *   command): what Claude Code shows the model when the user ran a slash
 *   command. Bare text blocks placed BEFORE the user's text on the next user
 *   message that opens a request (after the `first-prepend` stack on message
 *   one), then pinned there like a delivered one-shot. They never ride a tool
 *   result — a command run mid-turn waits for the next prompt. The caveat
 *   block is queued `once` per pending run (a second command joins the first
 *   caveat); the command and stdout blocks are never collapsed.
 *   `lib/local-command.ts` builds the blocks.
 *
 * Persisted or pinned is decided by WHEN the one-shot is emitted, which is a
 * load-order rule: system-reminder's `tool_result` hook takes the one-shots
 * pending at that moment, so only an extension whose own `tool_result` handler
 * runs BEFORE it (listed before `system-reminder` in `package.json`
 * `pi.extensions`, like `context-budget`) or that emits from `tool_call` gets
 * its block written into the result. Emitting from a later `tool_result`
 * handler, or from `tool_execution_end` (pi runs it AFTER the `tool_result`
 * hooks, findings §3), lands the block on the same result but as a pin. Same
 * wording on the wire, so this only matters for `--resume` and for ordering
 * after the `<total_tokens>` line.
 *
 * A compaction summary counts as a user message for anchoring (pi renders it as
 * one), so the context stack survives a compaction that left no user turn. So
 * does a `custom` harness message (task notification, wakeup, hook context):
 * pi sends it as a user message, and a turn it opens has no other user turn.
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
export type ReminderPlacement = "first-prepend" | "sticky-append" | "last-append" | "user-prepend";

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
	/** `user-prepend` only: skip when the same text is already pending (the shared caveat). */
	once?: boolean;
	/**
	 * `sticky-append` only: anchor the block from this timestamp instead of now —
	 * `0` puts it on every user message in the session, including ones a resume
	 * brought back (the `<total_tokens>` line rides every user message in CC).
	 */
	since?: number;
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
	/** `user-prepend` only: skip when the same text is already pending. */
	once?: boolean;
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
			return;
		}
		// A breadcrumb run shares one caveat block (`once`): the same text pending
		// twice would show the model two identical blocks in a row. Only the
		// announcer's caveat asks for this — two commands with the same (empty)
		// stdout are two commands, and both stay.
		if (placement === "user-prepend" && opts?.once && this.nextTurn.some((r) => r.placement === placement && r.text === text)) return;
		// A keyed next-turn reminder replaces its predecessor, so a rapidly
		// re-emitted state change (cycling permission modes) announces only
		// where it settled.
		if (opts?.key) this.nextTurn = this.nextTurn.filter((r) => r.key !== opts.key);
		this.nextTurn.push(entry);
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
		const { matching, rest } = partition(this.nextTurn, (r) => r.placement === "last-append");
		this.nextTurn = rest;
		return matching.map(strip);
	}

	/**
	 * Fix the pending one-shots of `placement` to `anchor` — the message they
	 * ride on this request — so every later request re-attaches them there
	 * unchanged. Called by the owner at `context` time, after it has decided the
	 * tail: `last-append` goes on the tail (`tailAnchor`), `user-prepend` only
	 * on a request that ends in a user-like message (`openingUserAnchor`) —
	 * mid-turn, breadcrumbs stay queued.
	 */
	pin(anchor: PinAnchor, placement: "last-append" | "user-prepend" = "last-append"): void {
		const { matching, rest } = partition(this.nextTurn, (r) => r.placement === placement);
		for (const entry of matching) this.pinned.push({ ...entry, pin: anchor });
		this.nextTurn = rest;
	}

	/**
	 * Everything to inject on this request: every-turn state, pinned one-shots,
	 * then whatever is still pending. A `user-prepend` breadcrumb leaves the
	 * queue only through `pin(anchor, "user-prepend")` (it must land on a user
	 * message, not a tool result), so an unpinned one stays for the next request. `messages` is the request being built:
	 * pins whose anchor is no longer in it (compacted away, or left behind on
	 * another branch) are dropped here, as part of draining, so no caller can
	 * forget the step. Nothing else is ever evicted: a pin is one small object,
	 * and removing a pin whose message is still in context would change that
	 * message and re-cache everything after it — the old "oldest past 400" cap
	 * did exactly that (CACHE-REVIEW-2026-09-04 M3).
	 */
	drain(messages: AgentMessage[]): ReminderEntry[] {
		if (this.pinned.length > 0) {
			const locate = pinLocator(messages);
			this.pinned = this.pinned.filter((entry) => locate(entry.pin as PinAnchor) !== -1);
		}
		const { matching: held, rest: pending } = partition(this.nextTurn, (r) => r.placement === "user-prepend");
		this.nextTurn = held;
		return [...[...this.everyTurn.values()].map(strip), ...this.pinned.map(strip), ...pending.map(strip)];
	}

	get size(): number {
		return this.everyTurn.size + this.nextTurn.length + this.pinned.length;
	}

	/** True when a one-shot of `placement` is waiting to be delivered (the owner decides where). */
	hasPending(placement: "last-append" | "user-prepend"): boolean {
		return this.nextTurn.some((r) => r.placement === placement);
	}

	/** `hasPending("last-append")` — kept for the existing callers and tests. */
	get hasPendingOneShots(): boolean {
		return this.hasPending("last-append");
	}
}

/** One pass: the entries `test` accepts and the rest, in order. */
function partition<T>(items: T[], test: (item: T) => boolean): { matching: T[]; rest: T[] } {
	const matching: T[] = [];
	const rest: T[] = [];
	for (const item of items) (test(item) ? matching : rest).push(item);
	return { matching, rest };
}

function strip(r: StoredReminder): ReminderEntry {
	const entry: ReminderEntry = { text: r.text, placement: r.placement, order: r.order, suffix: r.suffix };
	if (r.raw) entry.raw = true;
	if (r.since !== undefined) entry.since = r.since;
	if (r.pin !== undefined) entry.pin = r.pin;
	return entry;
}

/**
 * One pass over `messages` → a lookup from a pin to the index of the message it
 * rides (-1 when that message left the context). Built once per request by the
 * queue's drain and once by injectReminders, so pin count never multiplies the
 * message count on the per-request path.
 */
function pinLocator(messages: AgentMessage[]): (pin: PinAnchor) => number {
	const byToolCall = new Map<string, number>();
	const byTimestamp = new Map<number, number>();
	messages.forEach((m, index) => {
		if (m.role === "toolResult") {
			const id = (m as { toolCallId?: string }).toolCallId;
			if (typeof id === "string" && !byToolCall.has(id)) byToolCall.set(id, index);
		} else if (isUserLike(m)) {
			const stamp = (m as { timestamp?: number }).timestamp;
			if (typeof stamp === "number" && !byTimestamp.has(stamp)) byTimestamp.set(stamp, index);
		}
	});
	return (pin) => (pin.kind === "toolResult" ? byToolCall.get(pin.toolCallId) : byTimestamp.get(pin.timestamp)) ?? -1;
}

/** The anchor a one-shot lands on for this request: the trailing tool result, else the last user-like message. */
export function tailAnchor(messages: AgentMessage[]): PinAnchor | undefined {
	const last = messages[messages.length - 1] as (AgentMessage & { toolCallId?: string }) | undefined;
	if (last?.role === "toolResult" && typeof last.toolCallId === "string") return { kind: "toolResult", toolCallId: last.toolCallId };
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as AgentMessage & { timestamp?: number };
		if (isUserLike(m) && typeof m.timestamp === "number") {
			return { kind: "user", timestamp: m.timestamp };
		}
	}
	return undefined;
}

/**
 * The anchor for a `user-prepend` breadcrumb on this request: the trailing
 * message when it is a user-like turn (the prompt that opens the request), else
 * undefined — mid-turn (a trailing tool result) the breadcrumbs keep waiting.
 */
export function openingUserAnchor(messages: AgentMessage[]): PinAnchor | undefined {
	const last = messages[messages.length - 1] as (AgentMessage & { timestamp?: number }) | undefined;
	if (last && isUserLike(last) && typeof last.timestamp === "number") return { kind: "user", timestamp: last.timestamp };
	return undefined;
}

/** A tool result's content with reminder blocks appended (for the `tool_result` hook). */
export function appendReminderBlocks(content: ContentBlock[], entries: ReminderEntry[]): ContentBlock[] {
	return [...content, ...entries.map(reminderBlock)];
}

/**
 * The framings a reminder/countdown block appended onto a tool result begins
 * with: a `<system-reminder>`-wrapped one-shot, or a raw one-shot (the
 * context-budget `<total_tokens>` countdown, an LSP `<new-diagnostics>` block).
 * A PostToolUse hook that replaces the whole result must re-attach the trailing
 * run of these, or it silently drops the harness's own context (review M3).
 */
const APPENDED_REMINDER_PREFIXES = ["<system-reminder>", "<total_tokens>", "<new-diagnostics>"];

/** True when a text block is one the reminder queue appended onto a tool result. */
export function isAppendedReminderText(text: string): boolean {
	return APPENDED_REMINDER_PREFIXES.some((prefix) => text.startsWith(prefix));
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

/**
 * Roles a reminder block can be attached to. `custom` is a harness message
 * (task notification, wakeup, hook context, `<new-diagnostics>`); pi's
 * `convertToLlm` sends it to the model as `role: "user"`, so on the wire it IS
 * a user turn — and a turn opened by one (a `/loop` tick, an agent report
 * arriving while idle) has no `user` message of its own. Before 2026-09-05 such
 * a request got no context stack at all, and its pending one-shots pinned to
 * the previous user message (STEERING-REVIEW-2026-09-05 H1).
 */
function isUserLike(m: AgentMessage): boolean {
	return isStickyCarrier(m) || m.role === "compactionSummary";
}

/** User-role messages that carry sticky blocks: real turns and harness messages, not a compaction summary. */
function isStickyCarrier(m: AgentMessage): boolean {
	return m.role === "user" || m.role === "custom";
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
	// An unpinned `user-prepend` never reaches here through the queue (drain
	// holds it back); a caller passing one directly gets it on the opening user
	// message, before the text, like a pinned one.
	const looseUserPrepend = entries.filter((e) => e.placement === "user-prepend" && e.pin === undefined);

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
			if (!isStickyCarrier(m)) return;
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
	if (lastUserIndex !== -1) push(before, lastUserIndex, looseUserPrepend.map(reminderBlock));

	// Pinned one-shots ride the exact message they first landed on; a message
	// compacted away simply no longer carries its pin. A pinned breadcrumb sits
	// BEFORE that message's text (after the first-prepend stack, which was
	// pushed first); every other pin sits after it.
	if (pinnedEntries.length > 0) {
		const locate = pinLocator(messages);
		for (const entry of pinnedEntries) {
			const index = locate(entry.pin as PinAnchor);
			if (index === -1) continue;
			push(entry.placement === "user-prepend" ? before : after, index, [reminderBlock(entry)]);
		}
	}

	if (before.size === 0 && after.size === 0) return messages;
	return messages.map((m, index) => withBlocks(m, before.get(index) ?? [], after.get(index) ?? []));
}

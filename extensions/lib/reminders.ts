/**
 * System-reminder queue — the steering mechanism shared by all One Code
 * extensions. Reminders are injected transiently into the outgoing request via
 * pi's `context` event. Context and sticky snapshots are stored as hidden custom
 * entries by the owner, never as rendered transcript messages.
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
 *   mode, a worktree session, ultracode). Appended to EVERY user message
 *   stamped after the state switched on (`since`). Mid-turn it first rides the
 *   switching call's tool result (`toolCallId` → `tailPin`), or the first
 *   carrier after the switch, never the already-cached turn opener. That pin
 *   and every later user carrier keep identical bytes. Switching off CLOSES
 *   the lifetime (`until`) and freezes its actual user carriers (`userPins`),
 *   so queued input cannot acquire past state. It never removes blocks from
 *   history. Re-entry opens a separate lifetime. Closed lifetimes
 *   are persisted alongside open ones and dropped only when all their carriers
 *   leave the context (compaction/fork). They never migrate onto a compaction
 *   summary; retained messages still carry their historical blocks. Legacy
 *   `opener` anchors are honored on resume, but never created for new states.
 * - `last-append` — ONE-SHOT STEERING about what just happened (a deferred tool
 *   miss, a file changed under the model, a mode change). Delivered where the
 *   model reads next, and then KEPT there so the message never changes again:
 *   a one-shot pending when a tool result is stored is written INTO that result
 *   (`takeOneShots` from the `tool_result` hook — Claude Code persists its
 *   mid-turn reminders the same way, so the transcript carries them and no
 *   request ever re-caches the result); a one-shot still pending when a request
 *   goes out is `pin`ned to the request's tail (the trailing tool result by call
 *   id, else the last user message by timestamp) and re-attached to that same
 *   message on every later request, byte-identical. Pins are persisted with
 *   sticky lifetimes so a resume also preserves the switch announcements.
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
 * fixed sequence on the first user message: environment → model line → deferred
 * tools → agent catalog → MCP instructions → skills → the instructions block →
 * the context block → the date (just before the user's text). Gaps leave room
 * for One Code-specific reminders (e.g. subagent models). On a model that takes
 * a mid-conversation system message, everything below `claudeMd`, and the date,
 * moves into that message instead (`movesToSystemRole`, lib/system-role.ts).
 */
export const CONTEXT_ORDER = {
	environment: 1,
	modelLine: 2,
	/** One Code's note that a `-p`/json run ends with its turn (`lib/notifications.ts oneShotSessionNote`); not Claude Code's. */
	oneShot: 3,
	deferredTools: 10,
	subagentModels: 20,
	agents: 21,
	/** Tiny-tier-only strict delegation directive, right after the catalog. */
	delegation: 22,
	mcp: 30,
	skills: 40,
	/** Claude Code's auto-mode note; only in the system message (`systemRoleOnly`). */
	autoModeNote: 45,
	/** The `<total_tokens>` line the first prompt carries (later prompts: lib/turn-budget-layout.ts). */
	totalTokens: 46,
	// CLAUDE.md-family (with AGENTS.md as a per-directory fallback when a directory
	// has no CLAUDE.md) — CLAUDE.md > AGENTS.md.
	claudeMd: 50,
	// One Code's own instructions ride in their own block AFTER the instructions
	// block (higher `order` = closer to the user text = higher precedence), so
	// ONECODE.md takes precedence over CLAUDE.md/AGENTS.md. Not part of CC.
	oneCodeMd: 52,
	/** The user's email and the git snapshot. */
	context: 54,
	date: 56,
} as const;

/**
 * Whether a `first-prepend` block of this order leaves the first user message
 * for the mid-conversation system message on a model that takes one: the
 * session facts below the instructions block, and the date, which Claude Code
 * puts last in that message. The instructions, One Code's own block and the
 * context block stay in the user message.
 */
export function movesToSystemRole(order: number): boolean {
	return order < CONTEXT_ORDER.claudeMd || order === CONTEXT_ORDER.date;
}

/** A drained reminder with everything the injector needs to place it. */
export interface ReminderEntry {
	/** Present in session snapshots; not rendered into the request. */
	key?: string;
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
	 * `sticky-append` only: when the state switched on. Every user message
	 * stamped at or after it carries the block while open. Closing freezes the
	 * actual carriers in `userPins`; legacy snapshots use `until` as the end.
	 */
	since?: number;
	/** `sticky-append` only: exclusive end of a closed lifetime; absent while active. */
	until?: number;
	/** Actual user carriers of the last request; frozen on close, so queued input cannot acquire old state. */
	userPins?: number[];
	/** Pending sticky activation belongs to this call, not another result in its parallel batch. */
	toolCallId?: string;
	/**
	 * Legacy `sticky-append` anchor from older snapshots. Honored to keep their
	 * bytes stable on resume; new lifetimes use null, never an earlier opener.
	 */
	opener?: number | null;
	/**
	 * `sticky-append` only: its first mid-turn tool result, or the tail of a
	 * request without any user carrier (overflow compaction). Once chosen it
	 * stays on that message, even after later user turns arrive or state closes.
	 */
	tailPin?: PinAnchor;
	/** Set on a pinned one-shot: the exact message it rides on every request. */
	pin?: PinAnchor;
	/**
	 * Emit `text` as-is instead of inside a `<system-reminder>` frame — for the
	 * few Claude Code blocks that ride bare, like `<total_tokens>` after a tool
	 * result. Defaults to false.
	 */
	raw?: boolean;
	/**
	 * `first-prepend` only: sent only inside the mid-conversation system
	 * message, never on the user message of a model without one (Claude Code's
	 * auto-mode note).
	 */
	systemRoleOnly?: boolean;
	/**
	 * `sticky-append` only: never on the message that carries the context
	 * stack, which already says the same (the first prompt's `<total_tokens>`).
	 */
	skipStackCarrier?: boolean;
}

export interface ReminderPayload {
	text?: string;
	scope?: ReminderScope;
	/** Key so a reminder can be replaced (next-turn) or replaced/removed (every-turn). */
	key?: string;
	/** Close a sticky lifetime under `key`; remove other every-turn reminders. */
	remove?: boolean;
	/** Where in the message stack this reminder lands. Defaults to `last-append`. */
	placement?: ReminderPlacement;
	/** Sort key among `first-prepend` reminders (Claude Code order). Defaults to 0. */
	order?: number;
	/** Literal text appended after the closing `</system-reminder>` tag. Defaults to "". */
	suffix?: string;
	/** Emit the text bare, with no `<system-reminder>` frame. */
	raw?: boolean;
	/** `first-prepend` only: sent only inside the mid-conversation system message (see ReminderEntry). */
	systemRoleOnly?: boolean;
	/** `sticky-append` only: never on the message that carries the context stack (see ReminderEntry). */
	skipStackCarrier?: boolean;
	/** `user-prepend` only: skip when the same text is already pending (the shared caveat). */
	once?: boolean;
	/**
	 * `sticky-append` only: anchor the block from this timestamp instead of now —
	 * `0` puts it on every user message in the session, including ones a resume
	 * brought back (the `<total_tokens>` line rides every user message in CC).
	 */
	since?: number;
	/**
	 * The tool call whose result this reminder belongs to. For `last-append`,
	 * only that result's `tool_result` hook takes the one-shot. For a new sticky
	 * lifetime, that result is its first pin. Both avoid attaching a switch or
	 * countdown to another call in a parallel batch.
	 */
	toolCallId?: string;
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
	systemRoleOnly?: boolean;
	skipStackCarrier?: boolean;
	/** Test seam / explicit anchor for `sticky-append`; defaults to now. */
	since?: number;
	/** `user-prepend` only: skip when the same text is already pending. */
	once?: boolean;
	/** The switching tool result, or the hook that takes a one-shot (see ReminderPayload). */
	toolCallId?: string;
};

export class ReminderQueue {
	private nextTurn: StoredReminder[] = [];
	/** Delivered one-shots, each fixed to the message it first rode (see `pin`). */
	private pinned: StoredReminder[] = [];
	private everyTurn = new Map<string, StoredReminder>();
	/** Open and closed lifetimes in original insertion order, independent of live keys. */
	private sticky: StoredReminder[] = [];
	private readonly now: () => number;
	/** Only restored keys are protected; fresh sessions retain their existing emitter behavior. */
	private restoredKeys = new Set<string>();
	private pendingCapabilities = new Set<string>();

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	enqueue(text: string, opts?: EnqueueOptions): void {
		if (!text.trim()) return;
		const placement = opts?.placement ?? "last-append";
		if (placement === "first-prepend" && opts?.key) {
			if (this.restoredKeys.has(opts.key)) return;
			this.pendingCapabilities.delete(opts.key);
		}
		const entry: StoredReminder = {
			text,
			placement,
			order: opts?.order ?? 0,
			suffix: opts?.suffix,
			key: opts?.key,
			raw: opts?.raw,
			toolCallId: opts?.toolCallId,
		};
		if (opts?.systemRoleOnly) entry.systemRoleOnly = true;
		if (opts?.skipStackCarrier) entry.skipStackCarrier = true;
		const key = opts?.key ?? text;
		const previous = this.everyTurn.get(key);
		if (placement === "sticky-append") {
			// Re-emitting an unchanged standing fact keeps both its anchors and its
			// position among other blocks. A changed fact opens a new lifetime.
			const same = previous?.placement === placement && previous.text === text &&
				previous.suffix === entry.suffix && previous.raw === entry.raw &&
				previous.skipStackCarrier === entry.skipStackCarrier && previous.order === entry.order ? previous : undefined;
			entry.since = opts?.since ?? same?.since ?? this.now();
			entry.userPins = [];
			if (same && same.since === entry.since && opts?.scope === "every-turn") return;
		}
		if (opts?.scope === "every-turn") {
			if (previous?.placement === "sticky-append") this.remove(key);
			this.everyTurn.set(key, entry);
			if (placement === "sticky-append") {
				entry.key = key;
				this.sticky.push(entry);
			}
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
		if (!this.restoredKeys.has(key)) {
			const entry = this.everyTurn.get(key);
			if (entry?.placement === "sticky-append") entry.until = this.now();
			this.everyTurn.delete(key);
		}
		this.pendingCapabilities.delete(key);
	}

	/** Seed before startup emitters. Earlier hooks (context-budget) may already have emitted. */
	restore(stack: readonly ReminderEntry[], sticky: readonly ReminderEntry[], frozenKeys: ReadonlySet<string>, liveKeys: ReadonlySet<string> = new Set(), pinned: readonly ReminderEntry[] = []): void {
		const early = [...this.everyTurn.values()];
		this.everyTurn.clear();
		this.sticky = [];
		this.pinned = structuredClone([...pinned]);
		this.restoredKeys = new Set(frozenKeys);
		this.pendingCapabilities = new Set(stack.flatMap((entry) => entry.key && liveKeys.has(entry.key) ? [entry.key] : []));
		for (const source of [...stack, ...sticky]) {
			const entry = structuredClone(source);
			if (entry.placement === "sticky-append") this.sticky.push(entry);
			if (entry.until === undefined) this.everyTurn.set(entry.key ?? entry.text, entry);
		}
		for (const entry of early) this.enqueue(entry.text, { ...entry, scope: "every-turn" });
	}

	/**
	 * A session start with no snapshot (`/clear` after a resume): the previous
	 * session's resume locks must not keep the new session's emitters out.
	 */
	releaseRestore(): void {
		this.restoredKeys.clear();
		this.pendingCapabilities.clear();
	}

	/** The first request has seen all startup/turn emitters. An absent capability is gone. */
	finishRestore(): void {
		for (const key of this.pendingCapabilities) this.everyTurn.delete(key);
		this.pendingCapabilities.clear();
	}

	/** A compaction replaces these facts atomically, bypassing only their resume locks. */
	replaceFirstPrepend(keys: readonly string[], entries: readonly ReminderEntry[]): void {
		const replaced = new Set(keys);
		for (const key of replaced) this.everyTurn.delete(key);
		this.nextTurn = this.nextTurn.filter((entry) => !entry.key || !replaced.has(entry.key));
		for (const entry of entries) {
			if (entry.key && replaced.has(entry.key) && entry.placement === "first-prepend") {
				this.everyTurn.set(entry.key, structuredClone(entry));
			}
		}
	}

	/**
	 * A `/tree` switch to a branch whose last snapshot is `snapshot`: its
	 * session facts (`factKeys`, an absent one included), its sticky lifetimes
	 * and its pins come back, so its messages keep the bytes they were sent
	 * with. Live state stays live: other first-prepend blocks keep their
	 * current text, and a lifetime open on the branch stays open only while its
	 * owner still holds it, else it closes on its recorded carriers. What the
	 * branch left behind put here stays until a drain finds its carriers gone.
	 */
	restoreBranch(snapshot: { stack: readonly ReminderEntry[]; sticky: readonly ReminderEntry[]; pinned?: readonly ReminderEntry[] }, factKeys: readonly string[]): void {
		this.replaceFirstPrepend(factKeys, snapshot.stack);
		const same = (a: ReminderEntry, b: ReminderEntry) => a.key === b.key && a.text === b.text && a.since === b.since;
		const restored: StoredReminder[] = structuredClone([...snapshot.sticky]);
		const now = this.now();
		for (const entry of restored) {
			if (entry.until !== undefined) continue;
			const live = this.sticky.find((current) => current.until === undefined && same(current, entry));
			if (live?.key !== undefined && this.everyTurn.get(live.key) === live) this.everyTurn.set(live.key, entry);
			else entry.until = now;
		}
		this.sticky = [...restored, ...this.sticky.filter((current) => !restored.some((entry) => same(entry, current)))];
		const pinned: StoredReminder[] = structuredClone([...(snapshot.pinned ?? [])]);
		const known = new Set(pinned.map((entry) => JSON.stringify(strip(entry))));
		this.pinned = [...pinned, ...this.pinned.filter((entry) => !known.has(JSON.stringify(strip(entry))))];
	}

	/** A new snapshot supersedes undelivered notices about its old facts. Delivered pins stay history. */
	cancelPending(keys: readonly string[]): void {
		const cancelled = new Set(keys);
		this.nextTurn = this.nextTurn.filter((entry) => !entry.key || !cancelled.has(entry.key));
	}

	/** Hidden session metadata, preserving keys and insertion order without changing drain's API. */
	persistentEntries(placement: "first-prepend" | "sticky-append"): ReminderEntry[] {
		return [
			...(placement === "sticky-append" ? this.sticky.map((entry) => ({ ...strip(entry), key: entry.key })) :
				[...this.everyTurn.entries()].filter(([, entry]) => entry.placement === placement).map(([key, entry]) => ({ ...strip(entry), key }))),
			...this.nextTurn.filter((entry) => entry.placement === placement).map((entry) => ({ ...strip(entry), key: entry.key })),
		];
	}

	/** Delivered steering is history too, especially the notice that closes a sticky state. */
	persistentPins(): ReminderEntry[] {
		return this.pinned.map(strip);
	}

	/**
	 * Take the pending `last-append` one-shots out of the queue — for the
	 * `tool_result` hook, which writes them into the stored result. A one-shot
	 * bound to another call's result stays queued for that result's hook. Other
	 * placements stay queued for the next request.
	 */
	takeOneShots(toolCallId?: string): ReminderEntry[] {
		const { matching, rest } = partition(
			this.nextTurn,
			(r) => r.placement === "last-append" && (r.toolCallId === undefined || r.toolCallId === toolCallId),
		);
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
		const locate = pinLocator(messages);
		const stackCarrier = messages.findIndex(isUserLike);
		for (const entry of this.sticky) {
			if (entry.until !== undefined) continue;
			if (entry.opener === undefined) entry.opener = null;
			// Only live states may find a new carrier after compaction. A closed
			// state's missing pin must never move to the summary or a later turn.
			if (entry.tailPin && locate(entry.tailPin) === -1) entry.tailPin = undefined;
			if (entry.tailPin === undefined) entry.tailPin = firstStickyPin(messages, entry);
			// Timestamps alone cannot close a lifetime: a steer typed while it was
			// active can remain queued until after the switch. Keep only messages
			// that actually rode the block, including across a startup-time close.
			entry.userPins = messages.flatMap((m, index) => carriesSticky(m, entry) &&
				(!entry.skipStackCarrier || index !== stackCarrier) ? [m.timestamp] : []);
			if (entry.tailPin || entry.userPins.length > 0) delete entry.toolCallId;
		}
		this.sticky = this.sticky.filter((entry) => entry.until === undefined ||
			messages.some((m) => carriesSticky(m, entry)) || (entry.tailPin !== undefined && locate(entry.tailPin) !== -1));
		if (this.pinned.length > 0) this.pinned = this.pinned.filter((entry) => locate(entry.pin as PinAnchor) !== -1);
		const { matching: held, rest: pending } = partition(this.nextTurn, (r) => r.placement === "user-prepend");
		this.nextTurn = held;
		return [...[...this.everyTurn.values()].filter((entry) => entry.placement !== "sticky-append").map(strip),
			...this.sticky.map(strip), ...this.pinned.map(strip), ...pending.map(strip)];
	}

	get size(): number {
		return [...this.everyTurn.values()].filter((entry) => entry.placement !== "sticky-append").length +
			this.sticky.length + this.nextTurn.length + this.pinned.length;
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
	if (r.systemRoleOnly) entry.systemRoleOnly = true;
	if (r.skipStackCarrier) entry.skipStackCarrier = true;
	if (r.since !== undefined) entry.since = r.since;
	if (r.until !== undefined) entry.until = r.until;
	if (r.userPins !== undefined) entry.userPins = [...r.userPins];
	if (r.placement === "sticky-append" && r.toolCallId !== undefined) entry.toolCallId = r.toolCallId;
	if (r.opener !== undefined) entry.opener = r.opener;
	if (r.tailPin) entry.tailPin = r.tailPin;
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

/** Closed lifetimes keep only delivered carriers; legacy snapshots retain their timestamp interval. */
function carriesSticky(message: AgentMessage, entry: ReminderEntry): boolean {
	if (!isStickyCarrier(message)) return false;
	const stamp = (message as { timestamp?: number }).timestamp ?? 0;
	if (entry.until !== undefined && entry.userPins !== undefined) return entry.userPins.includes(stamp);
	return (stamp >= (entry.since ?? 0) && (entry.until === undefined || stamp < entry.until)) ||
		(entry.opener !== null && entry.opener !== undefined && stamp === entry.opener);
}

/** First carrier after activation; never reach back into an earlier user turn. */
function firstStickyPin(messages: AgentMessage[], entry: ReminderEntry): PinAnchor | undefined {
	if (entry.until !== undefined) return undefined;
	if (entry.toolCallId !== undefined) {
		return messages.some((m) => m.role === "toolResult" && m.toolCallId === entry.toolCallId)
			? { kind: "toolResult", toolCallId: entry.toolCallId } : undefined;
	}
	for (const message of messages) {
		if (carriesSticky(message, entry)) return undefined;
		if (message.role === "toolResult" && message.timestamp >= (entry.since ?? 0)) {
			return { kind: "toolResult", toolCallId: message.toolCallId };
		}
	}
	// Overflow compaction may retain only an old reply/result. With no real
	// user turn, a live state must still be visible and pinned to that tail.
	return messages.some(isStickyCarrier) ? undefined : tailAnchor(messages);
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

/** A reminder's text exactly as it rides a message: framed (unless raw), then its suffix. */
export function framedReminderText(entry: Pick<ReminderEntry, "text" | "raw" | "suffix">): string {
	return (entry.raw ? entry.text : wrapReminder(entry.text)) + (entry.suffix ?? "");
}

function reminderBlock(entry: ReminderEntry): TextContent {
	return { type: "text", text: framedReminderText(entry) };
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

	const locate = pinLocator(messages);
	for (const entry of sticky) {
		const carriers: number[] = [];
		messages.forEach((m, index) => {
			if (carriesSticky(m, entry)) carriers.push(index);
		});
		const pin = entry.tailPin ?? firstStickyPin(messages, entry);
		const pinned = pin ? locate(pin) : -1;
		if (pinned !== -1 && !carriers.includes(pinned)) carriers.unshift(pinned);
		if (entry.skipStackCarrier && carriers.includes(firstUserIndex)) {
			for (const index of carriers.filter((index) => index !== firstUserIndex).sort((a, b) => a - b)) push(after, index, [reminderBlock(entry)]);
			continue;
		}
		for (const index of carriers.sort((a, b) => a - b)) push(after, index, [reminderBlock(entry)]);
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

/**
 * System reminders: the steering blocks One Code adds to a request, rendered
 * once and then kept as sent (working-docs/features/lifecycle-grid-hunt/design.md
 * section 5). The ledger (extensions/ledger) sends through pi only the
 * messages after the last request's coverage, the tail, and takes everything
 * above it from that request's record. So a reminder is rendered only onto the
 * tail, rides the request that first carried it, and stays in the record
 * byte for byte; nothing here is restored or re-rendered later.
 *
 * Cross-extension contract: emit on the event bus channel
 * `one-code:system-reminder` with `{ text, placement? }`. The live
 * state lives in the system-reminder extension; do not import one from here
 * (jiti gives every extension its own module instance, so a shared export
 * steers nothing).
 *
 * Four placements, chosen by what kind of fact the reminder is:
 *
 * - `first-prepend`: SESSION CONTEXT (environment, deferred tools, agent
 *   catalog, MCP instructions, skills, `# claudeMd`). Live state, kept current
 *   by its owner; rendered only on a request that opens an epoch, in front of
 *   the first user message and ordered by `order`: Claude Code's first-message
 *   stack. Inside an epoch message 1 is the record, so a change is not
 *   rendered; its owner announces the difference at render time
 *   (RENDER_CHANNEL: live minus what the epoch told).
 * - `sticky-append`: SESSION STATE that switches on and off (auto mode, plan
 *   mode, a worktree session, ultracode). Appended to every user message of
 *   the tail stamped at or after the state switched on (`since`). Switched on
 *   mid-turn, it first rides the switching call's result (`toolCallId`), or
 *   the first result after the switch, never the already-sent turn opener.
 *   Removing it closes it: later messages stop carrying it, and the ones
 *   already sent keep it in the record.
 * - `last-append`: ONE-SHOT steering about what just happened (a deferred
 *   tool miss, a file changed under the model, a mode change). Persisted when
 *   emitted as a `one-code:pending` entry, so it survives `/reload` and quit
 *   and is gone with an abandoned `/tree` branch; delivered on the tail of the
 *   next request (the call's own result when `toolCallId` names one in the
 *   tail, else the trailing tool result, else the last user message), and
 *   recorded as consumed by that request.
 * - `user-prepend`: LOCAL-COMMAND BREADCRUMBS (`/clear`, `/model`, a panel
 *   command): pending like a one-shot, but placed only before the text of a
 *   prompt that opens a request; mid-turn it waits. The caveat block is
 *   queued `once` per run (a second command joins the first caveat); the
 *   command and stdout blocks are never collapsed. `lib/local-command.ts`
 *   builds them.
 *
 * A compaction summary counts as a user message for the stack (pi renders it
 * as one), and so does a `custom` harness message (task notification, wakeup,
 * hook context): pi sends it as a user message, and a turn it opens has no
 * other user turn.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { BlockFact, ToldFact } from "./ledger/records.ts";
import { contentHash } from "./ledger/wire.ts";
import type { MovedBlock } from "./system-role.ts";

export const REMINDER_CHANNEL = "one-code:system-reminder";

/**
 * Emitted by the system-reminder extension once per request, while it renders
 * the tail (a `RenderRequest`). An owner of a capability block subscribes and
 * adds the blocks this request needs from live state and what the epoch has
 * told: on a request inside an epoch, the names live now that the epoch has
 * not told yet. Computed when the request goes out, never when a change is
 * queued, so a capability that came and went before the request is never
 * announced.
 */
export const RENDER_CHANNEL = "one-code:render";

/** See the module header for which placement fits which kind of reminder. */
export type ReminderPlacement = "first-prepend" | "sticky-append" | "last-append" | "user-prepend";

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

export interface ReminderPayload {
	text?: string;
	/** Key so a reminder can be replaced (a pending one-shot, a live block) or removed (a live block). */
	key?: string;
	/** Remove the live block or close the sticky state under `key`. */
	remove?: boolean;
	/** Where in the message stack this reminder lands. Defaults to `last-append`. */
	placement?: ReminderPlacement;
	/** Sort key among `first-prepend` reminders (Claude Code order). Defaults to 0. */
	order?: number;
	/** Emit the text bare, with no `<system-reminder>` frame. */
	raw?: boolean;
	/** `first-prepend` only: sent only inside the mid-conversation system message, never on a user message. */
	systemRoleOnly?: boolean;
	/** `sticky-append` only: never on the message that carries the context stack, which already says the same. */
	skipStackCarrier?: boolean;
	/** `user-prepend` only: placed once per request, however many are pending (the shared caveat). */
	once?: boolean;
	/**
	 * `sticky-append` only: the state is on from this timestamp instead of now.
	 * `0` puts it on every user message (the `<total_tokens>` line rides every
	 * user message in Claude Code).
	 */
	since?: number;
	/**
	 * The tool call whose result this reminder belongs to. A one-shot rides that
	 * result when the request carries it; a sticky state rides it first. Both
	 * avoid attaching a switch or countdown to another call in a parallel batch.
	 */
	toolCallId?: string;
	/** `first-prepend` only: what the block tells the model, recorded when an epoch sends it. */
	facts?: ToldFact[];
}

/** The fact that the whole-text block `key` told `value` (a text, or a snapshot such as a git status). */
export function toldBlockFact(key: string, value: unknown): BlockFact {
	return { kind: "block", key, hash: contentHash(value) };
}

/** A live `first-prepend` block. */
export interface StackEntry {
	key: string;
	text: string;
	order: number;
	raw?: boolean;
	systemRoleOnly?: boolean;
	facts?: ToldFact[];
}

/** A live `sticky-append` state. */
export interface StickyEntry {
	key: string;
	text: string;
	raw?: boolean;
	/** When it switched on: user messages stamped at or after it carry it. */
	since: number;
	toolCallId?: string;
	skipStackCarrier?: boolean;
	/** True once a request carried it: a tool-result pin is only for its first delivery. */
	delivered: boolean;
}

/** A one-shot to place on this request: a pending entry, or a block an owner rendered for it. */
export interface OneShot {
	/** The pending entry's id; absent on a render-time block. */
	id?: string;
	text: string;
	raw?: boolean;
	placement: "last-append" | "user-prepend";
	toolCallId?: string;
	once?: boolean;
	facts?: ToldFact[];
}

/** What a capability owner adds on RENDER_CHANNEL. */
export interface RenderedBlock {
	text: string;
	/** What the block tells the model, recorded with the request that carries it. */
	facts?: ToldFact[];
}

/** The RENDER_CHANNEL payload. */
export interface RenderRequest {
	/** True when the request opens an epoch: the live stack is rendered, so owners add nothing. */
	epoch: boolean;
	/** What the epoch has told the model so far, by fact kind. */
	told: ReadonlyMap<string, ReadonlySet<string>>;
	/** Modes the epoch has told, by key: on or off as last told. */
	modes: ReadonlyMap<string, boolean>;
	/** Whole-text blocks the epoch has told, by key: the content hash of the text last told (`toldBlockFact`). */
	toldBlocks: ReadonlyMap<string, string>;
	/** The request's model. */
	model: { provider?: string; api?: string; id?: string; compat?: unknown } | undefined;
	/** Blocks for the tail of this request. */
	blocks: RenderedBlock[];
}

/**
 * The live reminder state: the `first-prepend` stack and the open sticky
 * states, as their owners last emitted them. One-shots are not held here:
 * they are persisted as pending entries when emitted.
 */
export class LiveReminders {
	private stack = new Map<string, StackEntry>();
	/** Open states in the order they switched on. */
	private sticky = new Map<string, StickyEntry>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * Apply one reminder payload. Returns "one-shot" for a `last-append` or
	 * `user-prepend` reminder, which the caller persists as a pending entry.
	 */
	apply(payload: ReminderPayload): "live" | "one-shot" | "ignored" {
		const placement = payload.placement ?? "last-append";
		if (payload.remove) {
			if (!payload.key) return "ignored";
			this.stack.delete(payload.key);
			this.sticky.delete(payload.key);
			return "live";
		}
		const text = payload.text;
		if (typeof text !== "string" || !text.trim()) return "ignored";
		if (placement === "last-append" || placement === "user-prepend") return "one-shot";
		const key = payload.key ?? text;
		if (placement === "first-prepend") {
			const entry: StackEntry = { key, text, order: payload.order ?? 0 };
			if (payload.raw) entry.raw = true;
			if (payload.systemRoleOnly) entry.systemRoleOnly = true;
			if (payload.facts) entry.facts = payload.facts;
			this.stack.set(key, entry);
			return "live";
		}
		const previous = this.sticky.get(key);
		const same = previous && previous.text === text && !!previous.raw === !!payload.raw && !!previous.skipStackCarrier === !!payload.skipStackCarrier;
		// Re-emitting an unchanged standing state keeps its start and delivery; a
		// changed one is a new state from now.
		if (same && (payload.since === undefined || payload.since === previous.since)) return "live";
		const entry: StickyEntry = { key, text, since: payload.since ?? this.now(), delivered: false };
		if (payload.raw) entry.raw = true;
		if (payload.skipStackCarrier) entry.skipStackCarrier = true;
		if (payload.toolCallId) entry.toolCallId = payload.toolCallId;
		this.sticky.delete(key);
		this.sticky.set(key, entry);
		return "live";
	}

	/** The stack in Claude Code's order (`order`, then emission order). */
	stackEntries(): StackEntry[] {
		return [...this.stack.values()].map((entry, i) => ({ entry, i })).sort((a, b) => a.entry.order - b.entry.order || a.i - b.i).map((x) => x.entry);
	}

	stickyEntries(): StickyEntry[] {
		return [...this.sticky.values()];
	}

	/** Record that a request carried these sticky states. */
	markDelivered(keys: readonly string[]): void {
		for (const key of keys) {
			const entry = this.sticky.get(key);
			if (entry) entry.delivered = true;
		}
	}
}

export interface RenderInput {
	/** The request opens an epoch: the stack goes on the first user message. */
	epoch: boolean;
	/** The model takes a mid-conversation system message (`systemRoleOnly` blocks render, `moved` is filled). */
	layout: boolean;
	stack: readonly StackEntry[];
	sticky: readonly StickyEntry[];
	oneShots: readonly OneShot[];
}

export interface RenderResult {
	messages: AgentMessage[];
	/** The stack blocks that move to the mid-conversation system message (epoch and layout only). */
	moved: MovedBlock[];
	/** True when the stack was placed. */
	stackPlaced: boolean;
	/** The sticky states this request carried. */
	stickyPlaced: string[];
	/** The one-shots this request carried. */
	placed: OneShot[];
}

type ContentBlock = TextContent | ImageContent;

/**
 * The request's messages (its tail, or all of them on an epoch) with the
 * reminders placed, and what was placed. The input is not mutated. A one-shot
 * that finds no anchor is not placed and stays pending.
 */
export function renderReminders(messages: readonly AgentMessage[], input: RenderInput): RenderResult {
	const before = new Map<number, TextContent[]>();
	const after = new Map<number, TextContent[]>();
	const push = (map: Map<number, TextContent[]>, index: number, blocks: TextContent[]) => {
		if (index < 0 || blocks.length === 0) return;
		map.set(index, [...(map.get(index) ?? []), ...blocks]);
	};
	const firstUser = messages.findIndex(isUserLike);
	const lastUser = messages.findLastIndex(isUserLike);
	const last = messages.length - 1;
	// Mid-turn, the request ends in the tool results the model is about to read:
	// a one-shot belongs there. Otherwise on the last user turn.
	const tail = last >= 0 && messages[last].role === "toolResult" ? last : lastUser;
	const stackAt = firstUser === -1 ? tail : firstUser;

	let stackPlaced = false;
	let moved: MovedBlock[] = [];
	if (input.epoch && stackAt !== -1) {
		const stack = input.stack.filter((entry) => input.layout || !entry.systemRoleOnly);
		push(before, stackAt, stack.map(block));
		stackPlaced = stack.length > 0;
		if (input.layout) {
			moved = stack.filter((entry) => movesToSystemRole(entry.order)).map((entry) => ({ framed: framedReminderText(entry), inner: entry.text }));
		}
	}

	const stickyPlaced: string[] = [];
	for (const state of input.sticky) {
		const carriers: number[] = [];
		messages.forEach((message, index) => {
			if (!isStickyCarrier(message) || stamp(message) < state.since) return;
			if (state.skipStackCarrier && input.epoch && index === firstUser) return;
			carriers.push(index);
		});
		if (!state.delivered) {
			const first = firstResultAfter(messages, state);
			if (first !== -1 && !carriers.includes(first)) carriers.unshift(first);
		}
		if (carriers.length === 0) continue;
		stickyPlaced.push(state.key);
		for (const index of carriers.sort((a, b) => a - b)) push(after, index, [block(state)]);
	}

	const placed: OneShot[] = [];
	const opening = last >= 0 && isUserLike(messages[last]) ? last : -1;
	const placedOnce = new Set<string>();
	for (const shot of input.oneShots) {
		if (shot.placement === "user-prepend") {
			if (opening === -1) continue;
			placed.push(shot);
			if (shot.once && placedOnce.has(shot.text)) continue;
			if (shot.once) placedOnce.add(shot.text);
			push(before, opening, [block(shot)]);
			continue;
		}
		const own = shot.toolCallId ? messages.findIndex((m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === shot.toolCallId) : -1;
		const at = own !== -1 ? own : tail;
		if (at === -1) continue;
		placed.push(shot);
		push(after, at, [block(shot)]);
	}

	const changed = before.size > 0 || after.size > 0;
	return {
		messages: changed ? messages.map((m, index) => withBlocks(m, before.get(index) ?? [], after.get(index) ?? [])) : [...messages],
		moved,
		stackPlaced,
		stickyPlaced,
		placed,
	};
}

function stamp(message: AgentMessage): number {
	return (message as { timestamp?: number }).timestamp ?? 0;
}

/**
 * Where a state switched on mid-turn first shows: its switching call's result
 * when the request carries it, else the first tool result stamped after the
 * switch, but never one after a user message that already carries it. With no
 * carrier at all (an overflow compaction kept only a reply and its results),
 * the request's tail.
 */
function firstResultAfter(messages: readonly AgentMessage[], state: StickyEntry): number {
	if (state.toolCallId !== undefined) {
		return messages.findIndex((m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === state.toolCallId);
	}
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (stamp(message) < state.since) continue;
		if (isStickyCarrier(message)) return -1;
		if (message.role === "toolResult") return i;
	}
	if (messages.some(isStickyCarrier)) return -1;
	const last = messages.length - 1;
	return last >= 0 && messages[last].role === "toolResult" ? last : -1;
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

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/** A reminder's text exactly as it rides a message: framed, unless raw. */
export function framedReminderText(entry: { text: string; raw?: boolean }): string {
	return entry.raw ? entry.text : wrapReminder(entry.text);
}

function block(entry: { text: string; raw?: boolean }): TextContent {
	return { type: "text", text: framedReminderText(entry) };
}

/**
 * Roles a reminder block can be attached to. `custom` is a harness message
 * (task notification, wakeup, hook context, `<new-diagnostics>`); pi's
 * `convertToLlm` sends it to the model as `role: "user"`, so on the wire it IS
 * a user turn — and a turn opened by one (a `/loop` tick, an agent report
 * arriving while idle) has no `user` message of its own (STEERING-REVIEW-2026-09-05 H1).
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

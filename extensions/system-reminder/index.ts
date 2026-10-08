/**
 * system-reminder extension — injects queued <system-reminder> blocks into the
 * outgoing LLM request (pi `context` event), and writes one-shots into the tool
 * result they follow (pi `tool_result` event) so they persist in the session
 * the way Claude Code's mid-turn reminders do. Context and sticky anchors are
 * restored from hidden custom entries; rendered messages stay untouched. This extension owns
 * the one queue instance; every other extension reaches it over
 * `one-code:system-reminder` (lib/reminders.ts has the placement contract).
 *
 * On a model that takes a mid-conversation system message (lib/system-role.ts),
 * its `before_provider_request` hook then lifts the session-fact blocks off the
 * first user message into one system message after it, Claude Code's layout.
 * It loads before tool-search and compaction, so replays and forks inherit it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLEAR_AT_BETA, MID_CONVERSATION_SYSTEM_BETA, reseatMessageMark, withBetas } from "../lib/anthropic-payload.ts";
import {
	appendReminderBlocks,
	framedReminderText,
	injectReminders,
	movesToSystemRole,
	openingUserAnchor,
	REMINDER_CHANNEL,
	ReminderQueue,
	type ReminderEntry,
	type ReminderPayload,
	tailAnchor,
} from "../lib/reminders.ts";
import {
	CONTEXT_BASELINE_CHANNEL, CONTEXT_RESTORE_CHANNEL, CONTEXT_STACK_ENTRY, CONTEXT_STATE_ENTRY, CONTEXT_FACTS_REFRESH_CHANNEL,
	contextStackOnBranch, RESTORED_STACK_KEYS, LIVE_CONTEXT_KEYS,
	type ContextBaseline, type ContextRestoreRequest, type ContextStackSnapshot, type ContextFactsRefresh,
} from "../lib/context-stack.ts";
import { CONTEXT_FACT_KEYS, DATE_CHANGE_KEY, RESUME_FACTS_KEY } from "../lib/context-facts.ts";
import { claudeFamily } from "../lib/model-tier.ts";
import { instructionRole, messagesKey, type MovedBlock, systemRoleLayout, wireShape, withSystemRoleContext } from "../lib/system-role.ts";
import { resolveCountdowns, withTurnBudgetMessages } from "../lib/turn-budget-layout.ts";

/**
 * Roles a reminder can be attached to (see injectReminders). `custom` is a
 * harness message (a task notification, a wakeup, hook context) that pi sends
 * to the model as a user message; a turn opened by one has no `user` message
 * of its own, so without it the model got no reminder stack at all
 * (STEERING-REVIEW-2026-09-05 H1).
 */
const ANCHOR_ROLES = new Set(["user", "toolResult", "compactionSummary", "custom"]);

export default function systemReminderExtension(pi: ExtensionAPI) {
	const reminderQueue = new ReminderQueue();
	let restored: ContextStackSnapshot | undefined;
	let stored = false;
	let baselines: Record<string, unknown> = {};
	let lastState = "";
	let lastStack = "";
	pi.events.on(CONTEXT_RESTORE_CHANNEL, (data) => {
		if (data && restored) (data as ContextRestoreRequest).restored = structuredClone(restored);
	});
	pi.events.on(CONTEXT_BASELINE_CHANNEL, (data) => {
		const baseline = data as ContextBaseline | undefined;
		if (typeof baseline?.key === "string") baselines[baseline.key] = structuredClone(baseline.value);
	});
	pi.on("session_start", (_event, ctx) => {
		restored = contextStackOnBranch(ctx.sessionManager.getBranch());
		stored = restored !== undefined;
		baselines = restored ? structuredClone(restored.baselines) : {};
		lastState = restored ? JSON.stringify({ version: 1, sticky: restored.sticky, baselines }) : "";
		lastStack = restored ? JSON.stringify(restored.stack) : "";
		if (restored) reminderQueue.restore(restored.stack, restored.sticky, RESTORED_STACK_KEYS, LIVE_CONTEXT_KEYS);
		else reminderQueue.releaseRestore();
	});
	const persistSnapshot = (stack: ReminderEntry[] = reminderQueue.persistentEntries("first-prepend")) => {
		const state = { version: 1 as const, sticky: reminderQueue.persistentEntries("sticky-append"), baselines };
		const serialized = JSON.stringify(state);
		const serializedStack = JSON.stringify(stack);
		if (!stored) {
			pi.appendEntry(CONTEXT_STACK_ENTRY, structuredClone({ ...state, stack }));
			stored = true;
		} else if (serialized !== lastState || serializedStack !== lastStack) {
			// Compaction and explicit capability switches start a new prefix.
			pi.appendEntry(CONTEXT_STATE_ENTRY, structuredClone({ ...state, ...(serializedStack !== lastStack ? { stack } : {}) }));
		}
		lastState = serialized;
		lastStack = serializedStack;
	};
	pi.events.on(CONTEXT_FACTS_REFRESH_CHANNEL, (data) => {
		const refresh = data as ContextFactsRefresh;
		reminderQueue.replaceFirstPrepend(CONTEXT_FACT_KEYS, refresh.entries);
		reminderQueue.cancelPending([DATE_CHANGE_KEY, RESUME_FACTS_KEY]);
		baselines["claude-context"] = structuredClone(refresh.baseline);
		// /compact may be the last action before exit. Persist now, not just on
		// the next request, so a resume cannot revive the pre-compaction facts.
		persistSnapshot();
	});
	/** The blocks the last `context` pass placed for the system message; the payload hook moves them. */
	let moved: MovedBlock[] = [];
	/** The tool results' countdowns the last `context` pass lifted, by call id (lib/turn-budget-layout.ts). */
	let countdowns = new Map<string, number>();

	pi.events.on(REMINDER_CHANNEL, (data) => {
		const payload = data as ReminderPayload;
		if (!payload) return;
		if (payload.remove && payload.key) {
			reminderQueue.remove(payload.key);
		} else if (typeof payload.text === "string") {
			reminderQueue.enqueue(payload.text, {
				scope: payload.scope,
				key: payload.key,
				placement: payload.placement,
				order: payload.order,
				suffix: payload.suffix,
				raw: payload.raw,
				systemRoleOnly: payload.systemRoleOnly,
				skipStackCarrier: payload.skipStackCarrier,
				since: payload.since,
				once: payload.once,
				toolCallId: payload.toolCallId,
			});
		}
	});

	// A one-shot pending when a tool result is stored goes INTO that result: the
	// model reads it right there, the session file keeps it, and no later request
	// re-caches the message (a transient block would vanish on the next request
	// and cost the result and everything after it). Runs before the hooks
	// extension's PostToolUse in load order, so a hook that replaces the whole
	// result would drop these appended blocks — the hooks extension re-attaches
	// the trailing reminder run when it applies a replacement (review M3,
	// applyPostToolUseOutcome / isAppendedReminderText).
	pi.on("tool_result", (event) => {
		if (!reminderQueue.hasPendingOneShots) return;
		const entries = reminderQueue.takeOneShots(event.toolCallId);
		if (entries.length === 0) return;
		return { content: appendReminderBlocks(event.content, entries) };
	});

	/** The request's messages with the queued reminders placed, or the input when nothing can be placed. */
	const withReminders = (messages: Parameters<typeof injectReminders>[0], layout: ReturnType<typeof systemRoleLayout>) => {
		if (reminderQueue.size === 0 && !stored) return messages;
		// injectReminders is a no-op when there is nothing to attach to. Only
		// consume the queue once there is somewhere to put the reminders, so they
		// survive to the next eligible request.
		if (!messages.some((m) => ANCHOR_ROLES.has(m.role))) return messages;
		// A one-shot that arrived after the last tool result was stored (a mode
		// change while idle, a deferred-tool miss whose call had no tool_result
		// hook) rides this request's tail — and stays pinned there afterwards.
		if (reminderQueue.hasPendingOneShots) {
			const anchor = tailAnchor(messages);
			if (anchor) reminderQueue.pin(anchor);
		}
		// A local-command breadcrumb rides the prompt that opens a request, before
		// the user's text (Claude Code's placement), and stays there. Mid-turn —
		// the request ends in a tool result — it waits for the next prompt.
		if (reminderQueue.hasPending("user-prepend")) {
			const anchor = openingUserAnchor(messages);
			if (anchor) reminderQueue.pin(anchor, "user-prepend");
		}
		// Capture first-prepend before draining (one may be next-turn), then save
		// after drain resolves sticky anchors. Store logical entries before layout,
		// including systemRoleOnly blocks even on a model that cannot carry them.
		reminderQueue.finishRestore();
		const stack = reminderQueue.persistentEntries("first-prepend");
		const drained = reminderQueue.drain(messages);
		persistSnapshot(stack);
		// A block meant only for the system message is left out where there is none.
		const reminders = drained.filter((entry) => layout || !entry.systemRoleOnly);
		if (layout) {
			moved = reminders
				.filter((entry) => entry.placement === "first-prepend" && movesToSystemRole(entry.order))
				.sort((a, b) => a.order - b.order)
				.map((entry) => ({ framed: framedReminderText(entry), inner: entry.text }));
		}
		return injectReminders(messages, reminders);
	};

	pi.on("context", (event, ctx) => {
		moved = [];
		countdowns = new Map();
		const layout = systemRoleLayout(ctx.model);
		const messages = withReminders(event.messages, layout);
		// Each tool result's stored <total_tokens> countdown, on every request so
		// the layout never depends on the queue: lifted for a system message or
		// framed, while the result's blocks are still separate (lib/turn-budget-layout.ts).
		// With the budget off no result carries one, so a tool's own such line stays its output.
		const budgetOn = process.env.CC_TOTAL_TOKENS !== "0";
		const resolved = budgetOn && ctx.model && wireShape(ctx.model.api) ? resolveCountdowns(messages, layout !== undefined) : undefined;
		if (resolved) countdowns = resolved.left;
		const out = resolved?.messages ?? messages;
		return out === event.messages ? undefined : { messages: out };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const shape = model ? wireShape(model.api) : undefined;
		if (!model || !shape) return undefined;
		const layout = systemRoleLayout(model);
		const role = instructionRole(shape, model);
		let payload = event.payload as Record<string, unknown>;
		if (layout) payload = withSystemRoleContext(payload, layout, moved, role) ?? payload;
		// Claude Code's per-turn <total_tokens> shapes; first-party Fable also
		// gets its clear_at nudge after each tool result.
		const firstParty = model.provider === "anthropic";
		const nudge = layout === "anthropic" && firstParty && claudeFamily(model.id) === "fable";
		const markers = process.env.CC_TOTAL_TOKENS !== "0";
		payload = withTurnBudgetMessages(payload, { shape, systemRole: layout !== undefined, role, left: countdowns, nudge, markers }) ?? payload;
		if (payload === event.payload) return undefined;
		if (shape === "anthropic") {
			const key = messagesKey(shape);
			payload = { ...payload, [key]: reseatMessageMark(payload[key] as Array<{ role?: unknown; content?: unknown }>) };
		}
		if (layout !== "anthropic" || !firstParty) return payload;
		return withBetas(payload, nudge ? [MID_CONVERSATION_SYSTEM_BETA, CLEAR_AT_BETA] : [MID_CONVERSATION_SYSTEM_BETA]);
	});
}

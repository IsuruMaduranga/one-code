/**
 * system-reminder extension — injects queued <system-reminder> blocks into the
 * outgoing LLM request (pi `context` event), and writes one-shots into the tool
 * result they follow (pi `tool_result` event) so they persist in the session
 * the way Claude Code's mid-turn reminders do. Standing and context reminders
 * stay transient: the session file never contains them. This extension owns
 * the one queue instance; every other extension reaches it over
 * `one-code:system-reminder` (lib/reminders.ts has the placement contract).
 *
 * On a model that takes a mid-conversation system message (lib/system-role.ts),
 * its `before_provider_request` hook then lifts the session-fact blocks off the
 * first user message into one system message after it, Claude Code's layout.
 * It loads before tool-search and compaction, so replays and forks inherit it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { totalTokensBlock, turnTokenBudget } from "../context-budget/budget.ts";
import { withBetas } from "../lib/anthropic-payload.ts";
import {
	appendReminderBlocks,
	framedReminderText,
	injectReminders,
	movesToSystemRole,
	openingUserAnchor,
	REMINDER_CHANNEL,
	ReminderQueue,
	type ReminderPayload,
	tailAnchor,
} from "../lib/reminders.ts";
import { instructionRole, type MovedBlock, type SystemRoleLayout, systemRoleLayout, withSystemRoleContext } from "../lib/system-role.ts";
import { framedTotalTokens, withTurnBudgetMessages } from "../lib/turn-budget-layout.ts";

/** Anthropic's beta for a `role: "system"` message after the first one, sent first-party as Claude Code does. */
const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
/** Anthropic's beta for a system message's `clear_at`, which Claude Code's Fable nudge carries. */
const CLEAR_AT_BETA = "mid-conversation-system-clear-at-2026-08-21";

/** The wire shape of a model's API, for the shapes the per-turn budget placements handle. */
function wireShape(api: string): SystemRoleLayout | undefined {
	if (api === "anthropic-messages") return "anthropic";
	if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") return "responses";
	if (api === "openai-completions") return "completions";
	return undefined;
}

/** The index of the first user message carrying the context stack's framed `<total_tokens>` block, on a model without the system role. */
function stackCarrier(messages: unknown, line: string): number | undefined {
	if (!Array.isArray(messages)) return undefined;
	const framed = framedTotalTokens(line);
	const index = messages.findIndex(
		(message: { role?: unknown; content?: unknown }) =>
			message?.role === "user" && Array.isArray(message.content) && message.content.some((part: { text?: unknown }) => part?.text === framed),
	);
	return index === -1 ? undefined : index;
}

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
	/** The blocks the last `context` pass placed for the system message; the payload hook moves them. */
	let moved: MovedBlock[] = [];
	/** The `<total_tokens>` line of the context stack, which the first prompt carries in place of its marker. */
	const firstPromptLine = totalTokensBlock(turnTokenBudget());

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

	pi.on("context", (event, ctx) => {
		moved = [];
		if (reminderQueue.size === 0) return;
		// injectReminders is a no-op when there is nothing to attach to. Only
		// consume the queue once there is somewhere to put the reminders, so they
		// survive to the next eligible request.
		if (!event.messages.some((m) => ANCHOR_ROLES.has(m.role))) return;
		// A one-shot that arrived after the last tool result was stored (a mode
		// change while idle, a deferred-tool miss whose call had no tool_result
		// hook) rides this request's tail — and stays pinned there afterwards.
		if (reminderQueue.hasPendingOneShots) {
			const anchor = tailAnchor(event.messages);
			if (anchor) reminderQueue.pin(anchor);
		}
		// A local-command breadcrumb rides the prompt that opens a request, before
		// the user's text (Claude Code's placement), and stays there. Mid-turn —
		// the request ends in a tool result — it waits for the next prompt.
		if (reminderQueue.hasPending("user-prepend")) {
			const anchor = openingUserAnchor(event.messages);
			if (anchor) reminderQueue.pin(anchor, "user-prepend");
		}
		const layout = systemRoleLayout(ctx.model);
		// A block meant only for the system message is left out where there is none.
		const reminders = reminderQueue.drain(event.messages).filter((entry) => layout || !entry.systemRoleOnly);
		if (layout) {
			moved = reminders
				.filter((entry) => entry.placement === "first-prepend" && movesToSystemRole(entry.order))
				.map((entry, index) => ({ entry, index }))
				.sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
				.map(({ entry }) => ({ framed: framedReminderText(entry), inner: entry.text }));
		}
		return { messages: injectReminders(event.messages, reminders) };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const shape = model ? wireShape(model.api) : undefined;
		if (!model || !shape) return undefined;
		const layout = systemRoleLayout(model);
		const role = instructionRole(shape, model);
		let payload = event.payload as Record<string, unknown>;
		let carrier: number | undefined;
		if (layout) {
			const lifted = withSystemRoleContext(payload, layout, moved, role);
			if (lifted) ({ payload, carrier } = lifted);
		} else {
			carrier = stackCarrier(payload[shape === "responses" ? "input" : "messages"], firstPromptLine);
		}
		// Claude Code's per-turn <total_tokens> shapes (lib/turn-budget-layout.ts);
		// first-party Fable also gets its clear_at nudge after each tool result.
		const firstParty = model.provider === "anthropic";
		const nudge = layout === "anthropic" && firstParty && /(?:^|[/.])claude-fable-/.test(model.id);
		payload = withTurnBudgetMessages(payload, { shape, systemRole: layout !== undefined, role, carrier, nudge }) ?? payload;
		if (payload === event.payload) return undefined;
		if (layout !== "anthropic" || !firstParty) return payload;
		return withBetas(payload, nudge ? [MID_CONVERSATION_SYSTEM_BETA, CLEAR_AT_BETA] : [MID_CONVERSATION_SYSTEM_BETA]);
	});
}

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
import { instructionRole, type MovedBlock, systemRoleLayout, withSystemRoleContext } from "../lib/system-role.ts";

/** Anthropic's beta for a `role: "system"` message after the first one, sent first-party as Claude Code does. */
const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";

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
		const layout = systemRoleLayout(model);
		if (!model || !layout || moved.length === 0) return undefined;
		const payload = withSystemRoleContext(event.payload as Record<string, unknown>, layout, moved, instructionRole(layout, model));
		if (!payload) return undefined;
		return layout === "anthropic" && model.provider === "anthropic" ? withBetas(payload, [MID_CONVERSATION_SYSTEM_BETA]) : payload;
	});
}

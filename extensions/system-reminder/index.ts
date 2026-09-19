/**
 * system-reminder extension — injects queued <system-reminder> blocks into the
 * outgoing LLM request (pi `context` event), and writes one-shots into the tool
 * result they follow (pi `tool_result` event) so they persist in the session
 * the way Claude Code's mid-turn reminders do. Standing and context reminders
 * stay transient: the session file never contains them. This extension owns
 * the one queue instance; every other extension reaches it over
 * `one-code:system-reminder` (lib/reminders.ts has the placement contract).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	appendReminderBlocks,
	injectReminders,
	openingUserAnchor,
	REMINDER_CHANNEL,
	ReminderQueue,
	type ReminderPayload,
	tailAnchor,
} from "../lib/reminders.ts";

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
				since: payload.since,
				once: payload.once,
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
		const entries = reminderQueue.takeOneShots();
		return { content: appendReminderBlocks(event.content, entries) };
	});

	pi.on("context", (event) => {
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
		const reminders = reminderQueue.drain(event.messages);
		return { messages: injectReminders(event.messages, reminders) };
	});
}

/**
 * system-reminder extension — injects queued <system-reminder> blocks into the
 * outgoing LLM request (pi `context` event). Transient by design: the session
 * file never contains the reminders, matching Claude Code behavior. This
 * extension owns the one queue instance; every other extension reaches it over
 * `one-code:system-reminder` (lib/reminders.ts has the placement contract).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { injectReminders, REMINDER_CHANNEL, ReminderQueue, type ReminderPayload } from "../lib/reminders.ts";

/** Roles a reminder can be attached to (see injectReminders). */
const ANCHOR_ROLES = new Set(["user", "toolResult", "compactionSummary"]);

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
			});
		}
	});

	pi.on("context", (event) => {
		if (reminderQueue.size === 0) return;
		// injectReminders is a no-op when there is nothing to attach to. Only
		// consume the queue once there is somewhere to put the reminders, so they
		// survive to the next eligible request.
		if (!event.messages.some((m) => ANCHOR_ROLES.has(m.role))) return;
		const reminders = reminderQueue.drain();
		return { messages: injectReminders(event.messages, reminders) };
	});

	// pi re-runs the context transform on every LLM attempt and emits a
	// message_end even for the attempt that failed (stopReason "error"/"aborted").
	// Next-turn reminders stay in flight until an assistant message really lands,
	// so the retry after a 429/529 carries them instead of the failed attempt
	// having swallowed them.
	pi.on("message_end", (event) => {
		const message = event.message as { role: string; stopReason?: string };
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		reminderQueue.commit();
	});
}

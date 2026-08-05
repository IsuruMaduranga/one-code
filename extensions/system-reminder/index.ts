/**
 * system-reminder extension — injects queued <system-reminder> blocks into the
 * outgoing LLM request (pi `context` event). Transient by design: the session
 * file never contains the reminders, matching Claude Code behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { injectReminders, REMINDER_CHANNEL, reminderQueue, type ReminderPayload } from "../lib/reminders.ts";

export default function systemReminderExtension(pi: ExtensionAPI) {
	pi.events.on(REMINDER_CHANNEL, (data) => {
		const payload = data as ReminderPayload;
		if (!payload) return;
		if (payload.remove && payload.key) {
			reminderQueue.remove(payload.key);
		} else if (typeof payload.text === "string") {
			reminderQueue.enqueue(payload.text, { scope: payload.scope, key: payload.key });
		}
	});

	pi.on("context", (event) => {
		if (reminderQueue.size === 0) return;
		const reminders = reminderQueue.drain();
		return { messages: injectReminders(event.messages, reminders) };
	});
}

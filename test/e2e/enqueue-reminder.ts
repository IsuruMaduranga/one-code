/**
 * E2E helper — enqueues a marker system-reminder via the event-bus contract
 * at session start, proving cross-extension steering works. Load with `pi -e`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function enqueueReminder(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		pi.events.emit("pi-claude-code:system-reminder", {
			text: "E2E_REMINDER_MARKER: this is a steering test. Ignore it.",
		});
	});
}

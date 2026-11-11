/**
 * One Code's monitor words (the profile's `text.background.monitor`): the
 * tool's description and parameters.
 */

import type { MonitorText } from "../../../extensions/sdk/profile.ts";

export const monitor: MonitorText = {
	description:
		"Start a background monitor that streams events from a long-running command. Each stdout line becomes a notification delivered to the conversation while you keep working; the command exiting ends the watch. Use for 'tell me every time X happens' (tail -f, an until-loop that polls a condition); for a single command's completion prefer bash with run_in_background: true — its completion notification arrives on its own. Returns a task id — stop with task_stop, inspect with task_output (both deferred — load them with tool_search). Alternatively pass `ws` to watch a WebSocket (each text frame is an event).",
	params: ({ defaultTimeoutMs, maxTimeoutMs }) => ({
		command: "Shell command; each stdout line is an event, exit ends the watch",
		description: "Short description of what is being monitored (shown in notifications)",
		persistent: "Run for the session lifetime (no timeout); stop with task_stop",
		timeoutMs: `Kill the monitor after this deadline (default ${defaultTimeoutMs}, max ${maxTimeoutMs}); ignored when persistent`,
		ws: "WebSocket to watch instead of a command; each text frame is an event, close ends the watch",
	}),
};

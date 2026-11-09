/**
 * One Code's monitor text (the profile's `text.background.monitor`).
 */

import type { MonitorEnd, MonitorStartFailure, MonitorText } from "../../../extensions/sdk/profile.ts";

function startFailed(failure: MonitorStartFailure): string {
	switch (failure.kind) {
		case "commandOrSocket":
			return "Pass exactly one of `command` or `ws`.";
		case "noShell":
			return `Cannot start the monitor: ${failure.osMessage ?? "no bash shell was found"}`;
		case "socketFailed":
			return `Could not open the WebSocket — check \`ws.url\` ("${failure.url}"): ${failure.osMessage}`;
	}
}

function how(end: MonitorEnd): string {
	switch (end.kind) {
		case "completed":
		case "failed":
			return end.kind;
		case "aborted":
			return "stopped (tool call aborted)";
		case "deadline":
			return end.persistentAsked
				? `stopped at its default deadline of ${end.ms} ms (persistent is not available in a one-shot session)`
				: `stopped at its ${end.ms} ms deadline`;
	}
}

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
	startFailed,
	started: ({ id, description }) =>
		`Monitor ${id} started (${description}). Events arrive as task notifications; stop with task_stop, inspect with task_output.`,
	ranToEnd: ({ id, description, end, events, note, output }) => `Monitor ${id} (${description}) ${how(end)} after ${events} event(s). ${note}\n\n${output}`,
	noEvents: "(no events)",
	noOutput: "(no output — the monitor received no events and nothing on stderr)",
	spoolLost: ({ keptChars }) =>
		`[The monitor's spool file could not be written, so only the last ${keptChars.toLocaleString("en-US")} characters of its output were kept.]\n`,
	earlierTruncated: "… (earlier output truncated)\n",
	moreLines: ({ hidden, taskId }) => `\n… +${hidden} more line(s) not shown — task_output ${taskId} has the full stream`,
};

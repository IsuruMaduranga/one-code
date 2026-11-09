/**
 * One Code's task_output and task_stop text (the profile's
 * `text.background.tasks`). task_stop's description is Claude Code's
 * TaskStop text without its agent-team and agent-name clauses: a task is
 * stopped by its id here. The clipped-output header is Claude Code's.
 */

import type { ShownTask, TaskToolsText } from "../../../extensions/sdk/profile.ts";

export const tasks: TaskToolsText = {
	outputDescription:
		"Retrieve output from a running or finished background task (monitor, background subagent, or background bash) by task id. block=true (default) waits up to `timeout` ms for completion; block=false returns the current status immediately. You never need this just to learn that a task finished — completion arrives as a task notification naming the output file; call this for the output itself, when your next step needs the result now, or for a mid-run peek.",
	outputParams: {
		taskId: "The task id to get output from",
		block: "Wait for completion (default true)",
		timeout: "Max wait in ms (default 30000)",
	},
	stopDescription:
		"\n- Stops a running background task by its ID\n- Takes a task_id parameter identifying the task to stop\n- Returns a success or failure status\n- Use this tool when you need to terminate a long-running task\n",
	stopParams: { taskId: "The ID of the background task to stop." },
	unknownTask: ({ id, known }) => `No background task "${id}". Known tasks: ${known.join(", ") || "(none)"}`,
	taskLine: (task: ShownTask) =>
		`${task.id} [${task.kind}] ${task.status} · ${task.description} · started ${task.finished ? `${task.seconds}s` : `${task.seconds}s ago`}`,
	noOutputYet: "(no output yet)",
	clippedHeader: ({ path }) => `[Truncated. Full output: ${path}]\n\n`,
	alreadyEnded: ({ id, status }) => `Task ${id} is already ${status}.`,
	residentEnded: ({ id, description }) =>
		`Terminated the resident agent behind ${id} (${description}); it can no longer be messaged live (SendMessage will resume it from its session file).`,
	stopRequested: ({ id, description }) => `Stop requested for ${id} (${description}).`,
};

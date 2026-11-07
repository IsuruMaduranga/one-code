/**
 * One Code's shell text (the profile's `text.shell`): Claude Code's Bash and
 * PowerShell descriptions with One Code's corrections (bash-description.ts,
 * powershell-description.ts), Claude Code's parameter and exit-code texts,
 * and One Code's guard blocks and background-run results.
 */

import type { ShellBlock, ShellEnd, ShellText } from "../../../extensions/lib/shell-text.ts";
import { BASH_PARAMS, bashDescription } from "./bash-description.ts";
import { powerShellToolDescription } from "./powershell-description.ts";
import { type ToolPassages, withoutOff } from "../../live-tools.ts";
import type { LiveTools } from "../../../extensions/lib/live-tools.ts";

function blocked(block: ShellBlock, live: LiveTools): string {
	switch (block.kind) {
		case "sleep": {
			const echo = block.rest ? `\`${block.shown}\` followed by: ${block.rest}` : `standalone \`${block.shown}\``;
			return (
				`Blocked: ${echo}. A foreground ${block.sleepName} stalls the whole session while it runs. ` +
				"To wait for a command you started, run it with run_in_background: true — its completion arrives as a task notification on its own, so you never need to poll. " +
				(live.has("monitor") ? `To wait for a condition, use the monitor tool with an until-loop (e.g. \`${block.untilExample}\`) — monitor is deferred, load it with tool_search select:monitor. ` : "") +
				"If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds. " +
				"Do not chain shorter sleeps to work around this block."
			);
		}
		case "pollingLoop":
			return (
				`Blocked: a foreground polling loop (\`${block.command}\`). It occupies the whole session while it spins. ` +
				(live.has("monitor")
					? "Use the monitor tool to run the until-loop for you (deferred — load it with tool_search select:monitor) — it returns when the condition holds — or start the underlying work with run_in_background: true and let its completion notification arrive on its own. "
					: "Start the underlying work with run_in_background: true and let its completion notification arrive on its own. ") +
				"Do not shorten the sleep or unroll the loop to work around this block."
			);
		case "detach":
			return (
				`Blocked: this command detaches a process with ${block.via}, leaving an orphan this session cannot manage — its output and exit status would be lost. ` +
				(live.has("task_output") && live.has("task_stop")
					? "Run it with run_in_background: true instead: it returns a task id immediately, completion arrives as a task notification, output stays readable with task_output, and it can be stopped with task_stop. "
					: "Run it with run_in_background: true instead: it returns a task id immediately and completion arrives as a task notification. ") +
				"If you need shell-level parallelism inside one command, end it with `wait` so the children are reaped."
			);
		case "editor":
			return `Blocked: \`${block.command}\` is an interactive editor and this shell has no TTY — it would hang until the timeout. Read files with the read tool and change them with ${live.has("edit") ? "edit/write" : "write"}.`;
		case "watch":
			return (
				"Blocked: `watch` needs an interactive terminal, which this shell does not have. " +
				`Use ${live.has("monitor") ? "the monitor tool (deferred — load it with tool_search select:monitor) to wait for a condition, or " : ""}run_in_background: true ${live.has("task_output") ? "with task_output to check on long-running output." : "for long-running output; its completion arrives as a task notification."}`
			);
		case "rebaseInteractive": {
			const accept = block.shell === "powershell" ? "`$env:GIT_SEQUENCE_EDITOR = ':'; git rebase …`" : "`GIT_SEQUENCE_EDITOR=: git rebase …`";
			return (
				"Blocked: `git rebase -i` opens an interactive editor, which this shell cannot provide — it would hang until the timeout. " +
				`Drive it non-interactively instead: ${accept} accepts the todo list as-is, or restructure history with \`git rebase --onto\`, \`git commit --amend\`, or \`git cherry-pick\`.`
			);
		}
		case "addInteractive":
			return (
				"Blocked: interactive `git add` prompts on a TTY this shell does not have — it would read EOF and stage nothing while appearing to succeed. " +
				"Stage whole files with `git add <paths>`, or stage a partial change non-interactively with `git apply --cached` and a crafted diff."
			);
		case "consolePrompt":
			return (
				`Blocked: \`${block.command}\` waits on a console or GUI prompt, and this shell runs -NonInteractive with stdin on the null device — it would error or hang until the timeout. ` +
				(live.has("ask_user_question") ? "Ask the user with ask_user_question instead, or pass the value on the command line." : "Pass the value on the command line instead.")
			);
	}
}

function failureDetail(end: ShellEnd): string | undefined {
	if (end.kind === "timedOut") return `timed out after ${end.seconds}s`;
	if (end.kind === "signal") return `terminated by ${end.signal ?? "unknown signal"}`;
	return undefined;
}

function finish(end: ShellEnd): string {
	if (end.kind === "stopped") return "stopped";
	if (end.kind === "completed") return "completed";
	return `failed (${failureDetail(end) ?? `exit code ${end.kind === "exitCode" ? end.code : ""}`})`;
}

const BASH_PASSAGES: ToolPassages = {
	monitor: [" Foreground `sleep` is blocked; use monitor with an until-loop to wait on a condition.", "  - Long leading `sleep` commands are blocked. To poll until a condition is met, use monitor with an until-loop (e.g. `until <check>; do sleep 2; done`) — you get a notification when the loop exits. Do not chain shorter sleeps to work around the block.\n", "  - Use the monitor tool to stream events from a background process (each stdout line is a notification). For one-shot \"wait until done,\" use bash with run_in_background instead.\n"],
	// After Agent's: with both off, its replacement leaves "task_create tool".
	Agent: [["task_create or Agent tools", "task_create tool"]],
	task_create: [["task_create or Agent tools", "Agent tool"], "- NEVER use the task_create tool\n", "- DO NOT use the task_create tool\n"],
	edit: [" - Edit files: Use edit (NOT sed/awk)\n"],
};

const STARTED_PASSAGES: ToolPassages = {
	task_output: [" If your next step cannot proceed without the result, task_output with block=true waits for it."],
	task_stop: [" Stop with task_stop."],
};

/** Names both task tools: the shorter sentence when either is off. */
const PS_TASK_TOOLS = [
	[
		"; completion arrives as a task notification, and the output is retrievable with task_output / stoppable with task_stop (both deferred — load them with tool_search; in a one-shot print/json session the call runs to completion within the foreground timeout and returns the output directly).",
		" and completion arrives as a task notification (in a one-shot print/json session the call runs to completion within the foreground timeout and returns the output directly).",
	],
] as const;

const POWERSHELL_PASSAGES: ToolPassages = {
	task_output: PS_TASK_TOOLS,
	task_stop: PS_TASK_TOOLS,
	monitor: ["; to wait on a condition use the monitor tool (deferred — load it with tool_search select:monitor)"],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const shellText = (live: LiveTools): ShellText => ({
	powershellPrimary: "PowerShell is the primary shell on this machine: use the powershell tool for terminal operations (git, npm, build tools)",
	bashDescription: ({ form, autoMode, searchTools }) => withoutOff(bashDescription(form, autoMode, searchTools), live, BASH_PASSAGES),
	bashParams: BASH_PARAMS,
	powershellDescription: ({ edition }) => withoutOff(powerShellToolDescription(edition), live, POWERSHELL_PASSAGES),
	powershellParams: {
		command: "The PowerShell command to execute",
		timeout: "Optional timeout in milliseconds (max 600000)",
		description: "Clear, concise description of what this command does in active voice.",
		run_in_background: "Set to true to run this command in the background.",
	},
	blocked: (block) => blocked(block, live),
	// Claude Code's failure text: `Exit code N`, then the output on its own lines.
	exitCode: ({ code, output }) => (output === "" ? `Exit code ${code}` : `Exit code ${code}\n${output}`).trimEnd(),
	noBackgroundShell: ({ label }) => `No ${label} executable is available for a background run.`,
	backgroundStarted: ({ label, id, description, logPath }) =>
		withoutOff(
			`⏳ ${label} task ${id} running in background (${description}).\n\nCompletion will arrive as a task notification on its own naming the output file — you do not need to wait for it or poll; keep working.${logPath ? ` To check interim output, read ${logPath}.` : ""} If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.`,
			live,
			STARTED_PASSAGES,
		),
	finish,
	failureDetail,
	ranToEnd: ({ label, id, description, end, note, deadline, logPath, output }) => {
		const stopped = deadline
			? ` It was stopped at ${deadline.explicit ? `its ${deadline.timeoutMs} ms timeout` : `the default ${deadline.timeoutMs} ms timeout (no \`timeout\` was given)`}: a one-shot session cannot keep a background command running after the run ends, so a server or watcher started this way stops at the deadline. Pass a longer \`timeout\` (max ${deadline.maxTimeoutMs}) for a long build.`
			: "";
		return `${label} task ${id} (${description}) ${finish(end)}. ${note}${stopped}${logPath ? ` Log: ${logPath}.` : ""}\n\n${output}`;
	},
	emptyOutput: "(no output — the command wrote nothing to stdout or stderr)",
	earlierTruncated: "… (earlier output truncated)\n",
	spoolLost: ({ keptChars }) => `[The command's spool file could not be written, so only the last ${keptChars.toLocaleString("en-US")} characters of its output were kept.]\n`,
});

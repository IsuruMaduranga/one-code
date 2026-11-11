/**
 * One Code's shell words (the profile's `text.shell`): Claude Code's Bash and
 * PowerShell descriptions with One Code's corrections (bash-description.ts,
 * powershell-description.ts) and Claude Code's parameter words.
 */

import type { LiveTools, ShellText } from "../../../extensions/sdk/profile.ts";
import { BASH_PARAMS, bashDescription } from "./bash-description.ts";
import { powerShellToolDescription } from "./powershell-description.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

const BASH_PASSAGES: ToolPassages = {
	monitor: [" Foreground `sleep` is blocked; use monitor with an until-loop to wait on a condition.", "  - Long leading `sleep` commands are blocked. To poll until a condition is met, use monitor with an until-loop (e.g. `until <check>; do sleep 2; done`) — you get a notification when the loop exits. Do not chain shorter sleeps to work around the block.\n", "  - Use the monitor tool to stream events from a background process (each stdout line is a notification). For one-shot \"wait until done,\" use bash with run_in_background instead.\n"],
	// After Agent's: with both off, its replacement leaves "task_create tool".
	Agent: [["task_create or Agent tools", "task_create tool"]],
	task_create: [["task_create or Agent tools", "Agent tool"], "- NEVER use the task_create tool\n", "- DO NOT use the task_create tool\n"],
	edit: [" - Edit files: Use edit (NOT sed/awk)\n"],
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
});

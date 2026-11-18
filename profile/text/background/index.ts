/**
 * One Code's background text (the profile's `text.background`): the cron
 * tools, schedule_wakeup, monitor, task_output, task_stop and /loop.
 */

import type { BackgroundText, LiveTools } from "../../../extensions/sdk/profile.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";
import { cron } from "./cron.ts";
import { loop } from "./loop.ts";
import { monitor } from "./monitor.ts";
import { tasks } from "./tasks.ts";
import { wakeup } from "./wakeup.ts";

export const background: BackgroundText = { cron, wakeup, monitor, tasks, loop };

/** Per tool, the passages of the task_output description that name it. */
const OUTPUT_PASSAGES: ToolPassages = {
	bash: [["(monitor or background bash)", "(monitor)"]],
	// After bash's: with both off, its replacement leaves the second form.
	monitor: [["(monitor or background bash)", "(background bash)"], [" (monitor)", ""]],
	Agent: [" Not for background agents: an agent's report arrives as its task notification, and this tool does not wait for one."],
};

/** The monitor description's pointers to a background bash run, for a session without the bash tool. */
const MONITOR_PASSAGES: ToolPassages = {
	bash: [
		["use **bash with `run_in_background`**", "use a **background shell run (`run_in_background`)**"],
		["use bash `run_in_background` with an `until` loop", "use a background shell run with an `until` loop"],
		["same shell environment as bash.", "same shell environment as your shell commands."],
		["Use bash when you need to transform", "Use a command when you need to transform"],
	],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const backgroundText = (live: LiveTools): BackgroundText => ({
	...background,
	monitor: { ...monitor, description: withoutOff(monitor.description, live, MONITOR_PASSAGES) },
	tasks: { ...tasks, outputDescription: withoutOff(tasks.outputDescription, live, OUTPUT_PASSAGES) },
});

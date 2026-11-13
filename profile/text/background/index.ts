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

/** Per tool, the passages of the monitor and task_output descriptions that name it. */
const DESCRIPTION_PASSAGES: ToolPassages = {
	bash: ["; for a single command's completion prefer bash with run_in_background: true — its completion notification arrives on its own", ["(monitor, background subagent, or background bash)", "(monitor or background subagent)"]],
	// After bash's: with both off, its replacement leaves the second form.
	monitor: [["(monitor, background subagent, or background bash)", "(background subagent or background bash)"], ["(monitor or background subagent)", "(background subagent)"]],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const backgroundText = (live: LiveTools): BackgroundText => ({
	...background,
	monitor: { ...monitor, description: withoutOff(monitor.description, live, DESCRIPTION_PASSAGES) },
	tasks: { ...tasks, outputDescription: withoutOff(tasks.outputDescription, live, DESCRIPTION_PASSAGES) },
});

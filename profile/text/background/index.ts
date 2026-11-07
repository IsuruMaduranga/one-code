/**
 * One Code's background text (the profile's `text.background`): the cron
 * tools, schedule_wakeup, monitor, task_output, task_stop and /loop.
 */

import type { BackgroundText } from "../../../extensions/background/text.ts";
import { cron } from "./cron.ts";
import { loop } from "./loop.ts";
import { monitor } from "./monitor.ts";
import { tasks } from "./tasks.ts";
import { wakeup } from "./wakeup.ts";

export const background: BackgroundText = { cron, wakeup, monitor, tasks, loop };

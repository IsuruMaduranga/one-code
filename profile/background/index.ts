/**
 * One Code's background text (the profile's `text.background`): the cron
 * tools, schedule_wakeup, monitor, task_output and task_stop so far.
 */

import type { BackgroundText } from "../../extensions/background/text.ts";
import { cron } from "./cron.ts";
import { monitor } from "./monitor.ts";
import { tasks } from "./tasks.ts";
import { wakeup } from "./wakeup.ts";

export const background: BackgroundText = { cron, wakeup, monitor, tasks };

/**
 * One Code's background text (the profile's `text.background`): the cron
 * tools and schedule_wakeup so far.
 */

import type { BackgroundText } from "../../extensions/background/text.ts";
import { cron } from "./cron.ts";
import { wakeup } from "./wakeup.ts";

export const background: BackgroundText = { cron, wakeup };

/**
 * One Code's recap text (the profile's `text.recap`): Claude Code's
 * away-summary instruction, verbatim from its 2.1.261 request
 * (services/awaySummary.ts, without the memory block).
 */

import type { RecapText } from "../../../extensions/recap/text.ts";

export const RECAP_PROMPT =
	"The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

export const recap: RecapText = {
	prompt: RECAP_PROMPT,
	stubReason: "Unavailable during this summary; answer in text.",
};

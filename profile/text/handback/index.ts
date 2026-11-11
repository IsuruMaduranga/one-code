/**
 * One Code's SubagentHandback words (the profile's `text.handback`): Claude
 * Code's description and its message parameter's.
 */

import type { HandbackText } from "../../../extensions/sdk/profile.ts";

export const handback: HandbackText = {
	description:
		"Deliver your final report to the agent that spawned you (your caller). Use it once, for that hand-off only: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so do everything else first and put everything your caller needs in that one report. It is not a messaging channel: do not use it for progress updates or questions.\n\nOnly a report delivered through SubagentHandback reaches your caller; plain text you write at the end of your run is NOT delivered. There is no recipient parameter: the report can only go to your caller.",
	messageParam: "Your full report for your caller",
};

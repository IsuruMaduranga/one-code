/**
 * One Code's SubagentHandback text (the profile's `text.handback`): Claude
 * Code's description, reminder and results, and One Code's load-first line
 * for a fork, where the tool is deferred (the fork sends its parent's tool
 * list): the frozen deferred listing it inherits does not name it.
 */

import type { HandbackText } from "../../../extensions/lib/handback-text.ts";

export const handback: HandbackText = {
	description:
		"Deliver your final report to the agent that spawned you (your caller). Use it once, for that hand-off only: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so do everything else first and put everything your caller needs in that one report. It is not a messaging channel: do not use it for progress updates or questions.\n\nOnly a report delivered through SubagentHandback reaches your caller; plain text you write at the end of your run is NOT delivered. There is no recipient parameter: the report can only go to your caller.",
	messageParam: "Your full report for your caller",
	reminder:
		"Your final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step. Only a SubagentHandback call reaches your caller as your result; plain text you write at the end is not delivered.",
	loadFirst: 'SubagentHandback is deferred here: load it first with tool_search (query "select:SubagentHandback").',
	delivered: "Report delivered to your caller.",
	alreadyDelivered: ({ sendMessage }) =>
		`Nothing was sent: your report was already delivered (SubagentHandback delivers one report). ${sendMessage ? "Use SendMessage for anything further, then stop." : "Stop now."}`,
	empty: "message must not be empty: pass your full report as `message`.",
};

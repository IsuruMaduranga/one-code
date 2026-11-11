/**
 * The SubagentHandback tool's words: every child session (an Agent run, a
 * fork, a workflow agent) hands its report back through it
 * (lib/agents/subagent-handback.ts). The profile words the tool itself
 * (`HandbackText`: description, message parameter); the reminder and the
 * delivery results are here (`handbackResultText`).
 */

export interface HandbackText {
	description: string;
	/** The `message` parameter's description. */
	messageParam: string;
}

/** The group's results, refusals and notes, which the base words (`handbackResultText`). */
export interface HandbackResultText {
	/** The closing reminder on the child's task message. */
	reminder: string;
	/** The line before the reminder in a fork, where the tool is deferred and must be loaded first. */
	loadFirst: string;
	delivered: string;
	/** A second hand-back in the same turn; `sendMessage` when the run can still message its caller (a subagent, not a workflow agent). */
	alreadyDelivered(p: { sendMessage: boolean }): string;
	/** A hand-back with an empty message. */
	empty: string;
}

/** The base's words of the group. */
export const handbackResultText: HandbackResultText = {
	reminder:
		"Your final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step. Only a SubagentHandback call reaches your caller as your result; plain text you write at the end is not delivered.",
	loadFirst: 'SubagentHandback is deferred here: load it first with tool_search (query "select:SubagentHandback").',
	delivered: "Report delivered to your caller.",
	alreadyDelivered: ({ sendMessage }) =>
		`Nothing was sent: your report was already delivered (SubagentHandback delivers one report). ${sendMessage ? "Use SendMessage for anything further, then stop." : "Stop now."}`,
	empty: "message must not be empty: pass your full report as `message`.",
};

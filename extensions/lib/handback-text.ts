/**
 * What the SubagentHandback tool needs from a profile (types only): every
 * child session (an Agent run, a fork, a workflow agent) hands its report
 * back through it (lib/subagent-handback.ts). The tool's name, its slot and
 * the run's end are the base's.
 */

export interface HandbackText {
	description: string;
	/** The `message` parameter's description. */
	messageParam: string;
	/** The closing reminder on the child's task message. */
	reminder: string;
	/** The line before the reminder in a fork, where the tool is deferred and must be loaded first. */
	loadFirst: string;
	delivered: string;
	/** A second hand-back in the same turn. */
	alreadyDelivered: string;
	/** A hand-back with an empty message. */
	empty: string;
}

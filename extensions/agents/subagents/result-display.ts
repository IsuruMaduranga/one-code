/**
 * What the transcript shows for an Agent or SendMessage result that is a
 * handle on a running agent, not a report. The model's text for those carries
 * instructions meant for it (wait for the notification, do not read the
 * output file, do not duplicate the work); the user sees Claude Code's short
 * line instead: "Backgrounded agent (↓ to manage · ctrl+o to expand)", with
 * the launch lines and the agent's prompt when expanded, and one status line
 * for a message sent. Built from the result's details, which never reach the
 * model. Undefined means the result is not one of these, and the tool's
 * usual renderer shows its text.
 */

interface RunDetails {
	agentRuns?: Array<{ name?: unknown }>;
	background?: unknown;
	lines?: unknown;
	pending?: unknown;
	steered?: unknown;
}

const BACKGROUNDED = "Backgrounded agent";

/** An Agent result: the line for a background launch. */
export function agentResultDisplay(details: unknown, view: { expanded: boolean; prompt?: string; expandHint: string | null }): string | undefined {
	const d = details as RunDetails | undefined;
	if (d?.background !== true) return undefined;
	const prompt = view.prompt?.trim();
	if (!view.expanded) {
		const hints = ["↓ to manage", ...(prompt && view.expandHint ? [view.expandHint] : [])];
		return `${BACKGROUNDED} (${hints.join(" · ")})`;
	}
	const lines = Array.isArray(d.lines) ? d.lines.filter((line): line is string => typeof line === "string") : [];
	return [BACKGROUNDED, ...lines, ...(prompt ? ["", prompt] : [])].join("\n");
}

/** A SendMessage result: the line for a message whose reply comes later as a notification (a one-shot reply is a report and shows as text). */
export function sendMessageResultDisplay(details: unknown): string | undefined {
	const d = details as RunDetails | undefined;
	const name = d?.agentRuns?.[0]?.name;
	if (d?.pending !== true || typeof name !== "string" || !name) return undefined;
	return d.steered === true ? `Message queued for ${name}` : `Message sent to ${name}`;
}

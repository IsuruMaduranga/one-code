/**
 * UserPromptSubmit context for messages the user queued mid-turn.
 *
 * pi 0.86+ fires `input` for a message queued while a turn runs (steer and
 * followUp, interactive or RPC), so UserPromptSubmit runs at queue time. That
 * message never reaches `before_agent_start`, which is where a prompt's hook
 * context rides, and pi delivers queued messages one per LLM call by default:
 * a separate context message queued behind it would reach the model one
 * request late, after the model already answered. So the context waits here,
 * keyed by the message's text, until pi delivers that message
 * (`message_start`), and then rides that same request as a one-shot reminder.
 *
 * Keyed by the raw typed text: pi removes a delivered message from its own
 * queue by the same comparison. A queued message pi expands first (a prompt
 * template) or an extension takes over (a skill command) never matches, so its
 * entry is dropped when the turn settles rather than delivered with a later,
 * unrelated prompt.
 */

/** A message's plain text, as pi compares queued messages (text blocks joined). */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

export class QueuedPromptContext {
	private entries: Array<{ text: string; context: string }> = [];

	add(text: string, context: string): void {
		this.entries.push({ text, context });
	}

	/** The context for the delivered message with this text, oldest first; removed once taken. */
	take(text: string): string | undefined {
		const index = this.entries.findIndex((entry) => entry.text === text);
		if (index === -1) return undefined;
		return this.entries.splice(index, 1)[0].context;
	}

	clear(): void {
		this.entries = [];
	}

	get size(): number {
		return this.entries.length;
	}
}

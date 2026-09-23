/**
 * Hold something for a message the user queued mid-turn until pi delivers it.
 *
 * Since pi 0.86 the `input` event also fires for a message queued while a turn
 * runs (`streamingBehavior` set; interactive queue, RPC steer/follow_up). A
 * one-shot reminder emitted there is taken by whatever the model reads next,
 * usually the running tool's result, so it lands before the message it is
 * about, a request or more early for a follow-up. A context message of its
 * own is no better: pi drains one queued message per request, so it arrives a
 * request late. Instead the caller holds the payload here, keyed by the typed
 * text, and releases it from `message_start` when pi delivers the user message
 * with that text (compare with pi-ai's `contentText(content, "")`, the
 * comparison pi uses for its own queue). pi awaits `message_start` before the
 * request that carries the message, so a `last-append` one-shot emitted then
 * is pinned to that message.
 *
 * A queued message pi expands first (a prompt template) never matches, nor
 * does one an extension replaces, unless its replacement carries the typed
 * text (the skill extension's `details.input`, which hooks matches). Clear on `agent_settled` so its payload
 * never rides a later, unrelated prompt, and on `session_start`.
 *
 * Pure (no pi imports); each extension keeps its own instance.
 */
export class QueuedDelivery<T> {
	private entries: Array<{ text: string; payload: T }> = [];

	hold(text: string, payload: T): void {
		this.entries.push({ text, payload });
	}

	/** The payload held for the delivered message with this text, oldest first; removed once released. */
	release(text: string): T | undefined {
		const index = this.entries.findIndex((entry) => entry.text === text);
		return index === -1 ? undefined : this.entries.splice(index, 1)[0].payload;
	}

	get isEmpty(): boolean {
		return this.entries.length === 0;
	}

	clear(): void {
		this.entries = [];
	}
}

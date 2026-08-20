/**
 * Detect whether an agent turn ended because the user interrupted it.
 *
 * pi marks the assistant message it was streaming with `stopReason: "aborted"`
 * when the user hits Esc (or otherwise calls `ctx.abort()`); a turn that ran to
 * completion carries "stop"/"toolUse"/etc. instead. Claude Code keys its
 * InterruptedByUser line off the same signal (ERROR_MESSAGE_USER_ABORT on the
 * last assistant message). Duck-typed so both the turn-duration and interrupted
 * extensions can share it without pulling in pi's message types.
 */

/** The last assistant message in a turn was aborted by the user. */
export function wasInterrupted(messages: ReadonlyArray<{ role: string; stopReason?: string }> | undefined): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message.stopReason === "aborted";
	}
	return false;
}

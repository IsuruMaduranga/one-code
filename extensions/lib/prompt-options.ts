/**
 * pi's system-prompt options for a session no `prompt()` has run in yet.
 *
 * A turn an extension opens from idle skips `before_agent_start`, the one
 * event that carries the options (upstream ask #17). After the first typed
 * prompt the extensions rebuild from what that event saw (system-prompt's
 * idle-turn.ts). Before it they have nothing, so a background completion that
 * opens a session's first turn used to go out as a user message, which takes
 * the prompt path and renders as a user bubble.
 *
 * A command handler's context does carry the options
 * (`getSystemPromptOptions`, the same base object `before_agent_start`
 * receives). So the command that starts background work announces them here:
 * system-prompt builds the prompt from them, the skill extension lists its
 * skills, and the notifier opens the turn with the notification itself as a
 * custom message, rendered like every later one. Pure: no pi imports.
 *
 * The same module carries the fork's system-prompt request (below).
 */

export const PROMPT_OPTIONS_CHANNEL = "one-code:prompt-options";

/** The payload: pi's base options, and the session cwd they were read in. */
export interface PromptOptionsAnnouncement {
	options: unknown;
	cwd: string;
}

/**
 * Emit the options of a command context. A context without
 * `getSystemPromptOptions` (an event handler's, or an older pi) announces
 * nothing, and the listeners keep their first-turn fallbacks.
 */
export function announcePromptOptions(events: { emit(channel: string, data: unknown): void }, ctx: unknown): void {
	const context = ctx as { getSystemPromptOptions?: () => unknown; cwd?: string } | undefined;
	if (typeof context?.getSystemPromptOptions !== "function") return;
	let options: unknown;
	try {
		options = context.getSystemPromptOptions();
	} catch {
		return; // A torn-down session: nothing to announce.
	}
	if (!options || typeof options !== "object") return;
	events.emit(PROMPT_OPTIONS_CHANNEL, { options, cwd: context.cwd ?? "" } satisfies PromptOptionsAnnouncement);
}

/**
 * The system prompt a fork inherits. `ctx.getSystemPrompt()` is pi's own
 * prompt whenever One Code's is not installed on pi's run: between turns (pi
 * drops a run's options when it settles), before the first prompt, and in a
 * turn opened from idle (installed on the wire only, by context_with_system).
 * A fork started then ran on pi's stock prompt. The system-prompt extension
 * answers this request synchronously with the prompt the session's next
 * request carries; no answer (not loaded, a named agent's own prompt, nothing
 * to build from) leaves the caller's fallback.
 */
export const SYSTEM_PROMPT_REQUEST_CHANNEL = "one-code:system-prompt-request";

export interface SystemPromptRequest {
	/** The requester's context: cwd and model shape the prompt. */
	ctx: unknown;
	/** Set by the listener before it returns. */
	prompt?: string;
}

/** Ask for One Code's system prompt; `undefined` when nobody answered. */
export function requestSystemPrompt(events: { emit(channel: string, data: unknown): void }, ctx: unknown): string | undefined {
	const request: SystemPromptRequest = { ctx };
	events.emit(SYSTEM_PROMPT_REQUEST_CHANNEL, request);
	return typeof request.prompt === "string" ? request.prompt : undefined;
}

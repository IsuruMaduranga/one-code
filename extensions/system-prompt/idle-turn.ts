/**
 * The system prompt for a turn that never passed `before_agent_start`.
 *
 * pi applies a `before_agent_start` prompt to the run that `prompt()` starts,
 * and drops it when that run settles. A turn an extension opens from idle
 * (`sendMessage(…, {triggerTurn: true})`: a cron or `/loop` tick, a background
 * shell, agent or monitor completion) skips that hook, so pi builds its
 * default prompt for it, the model loses One Code's instructions, and the
 * first such turn rewrites the prompt cache (findings §27; upstream ask #17).
 * The `context_with_system` handler rebuilds our prompt for every request from
 * the options the last `before_agent_start` saw, and installs it the way pi's
 * forced-prompt projection does. In a `prompt()` run that projection runs
 * afterwards and installs the same text. Pure: no pi imports.
 */

/** The option fields the prompt builder reads, as pi's `BuildSystemPromptOptions` carries them. */
export interface PromptToolOptions {
	selectedTools?: string[];
}

/**
 * The options to rebuild from: the last `before_agent_start` options with the
 * live tool set. An unchanged set keeps its old order, so the rebuilt prompt
 * is byte-identical to the one the cache holds; a changed one (plan mode, a
 * tool loaded while idle) is listed as pi now holds it.
 */
export function optionsForIdleTurn<T extends PromptToolOptions>(last: T, activeTools: string[]): T {
	const previous = last.selectedTools ?? [];
	const live = new Set(activeTools);
	const unchanged = previous.length === live.size && previous.every((name) => live.has(name));
	return unchanged ? last : { ...last, selectedTools: activeTools };
}

/** A transcript entry as far as the system head is concerned. */
export interface TranscriptEntry {
	role: string;
	timestamp?: number;
}

/** pi's replayed system message (`getCurrentSystemMessage`): its tools and timestamp carry over. */
export interface CurrentSystemMessage {
	toolsAdded?: unknown[];
	timestamp?: number;
}

/**
 * `messages` with every system message collapsed into one head holding
 * `prompt` and the current tools, as pi's `_installAgentForcedPromptProjection`
 * builds it, so a turn opened from idle sends the same request shape as a
 * typed one.
 */
export function withSystemHead<M extends TranscriptEntry>(
	messages: M[],
	prompt: string,
	current: CurrentSystemMessage | undefined,
	now: number = Date.now(),
): M[] {
	const head = {
		role: "system",
		content: prompt,
		...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
		timestamp: current?.timestamp ?? now,
	} as unknown as M;
	return [head, ...messages.filter((message) => message.role !== "system")];
}

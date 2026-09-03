/**
 * Claude Code's context-budget signal, pure half. CC appends a bare
 * `<total_tokens>N tokens left</total_tokens>` line to every tool result so
 * the model can pace itself against the window (its `# Context management`
 * prompt section promises summarization but gives no number without this).
 * The value is what remains before the window is full.
 */

export interface ContextUsageLike {
	tokens?: number | null;
	contextWindow?: number | null;
}

/** Remaining tokens, or undefined when the usage is unknown or incomplete. */
export function tokensLeft(usage: ContextUsageLike | undefined): number | undefined {
	if (!usage) return undefined;
	const { tokens, contextWindow } = usage;
	if (typeof tokens !== "number" || typeof contextWindow !== "number") return undefined;
	if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	return Math.max(0, Math.round(contextWindow - tokens));
}

/** The bare block Claude Code appends, byte-for-byte. */
export function totalTokensBlock(left: number): string {
	return `<total_tokens>${left} tokens left</total_tokens>`;
}

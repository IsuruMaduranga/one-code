/**
 * Shared pieces of a stateless side-model call — a one-off completion made over
 * (a slice of) the current conversation, outside the main agent loop. Used by
 * the recap extension (the "while you were away" summary) and the btw extension
 * (Claude Code's `/btw` side question). Kept free of runtime pi imports (only a
 * pi-ai type) so it stays unit-testable and importable from pure prompt modules.
 */

import type { Tool } from "@earendil-works/pi-ai";

/**
 * Name-only tool declarations: enough for a provider to accept the `tool_use`
 * blocks already in a shared history, without the descriptions and schemas. A
 * side call never invokes a tool (its prompt asks for text), and the empty
 * schema keeps the model answering in text on strict providers that reject a
 * history carrying `tool_use` blocks with no tools declared.
 */
export function toolStubs(names: readonly string[], reason = "Unavailable for this call; answer in text."): Tool[] {
	return names.map(
		(name) =>
			({
				name,
				description: reason,
				parameters: { type: "object", properties: {} },
			}) as unknown as Tool,
	);
}

/**
 * Trim a message history forward to the first clean turn boundary — a `user`
 * prompt or an `assistant` reply. A raw history can begin mid-exchange with a
 * leading `tool_result` message whose matching `assistant` `tool_use` is absent,
 * which strict providers (e.g. Anthropic) reject as an orphan `tool_result`. An
 * assistant start is safe: its own tool results follow. When there is no
 * user/assistant message at all, nothing is safe to send and this returns empty.
 * Generic over `{ role }` so it is testable with plain objects.
 */
export function trimToTurnBoundary<T extends { role: string }>(messages: readonly T[]): T[] {
	const start = messages.findIndex((message) => message.role === "user" || message.role === "assistant");
	return start === -1 ? [] : messages.slice(start);
}

/**
 * The conversation without pi's `system` transcript messages, for a capture of
 * the `context` event. pi 0.86 hands `context` handlers a leading system message
 * holding pi's own default prompt sections and every full tool schema; a side
 * call that forwarded it had pi-ai replay those into its system prompt and tools
 * (over the stubs), and it shifted every role-by-index comparison. pi 0.87 strips
 * system messages before `context` handlers run, so there this is a no-op.
 */
export function withoutSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}

/** The placeholder left in a message whose only content was an image we removed. */
export const IMAGE_OMITTED_TEXT = "[image omitted]";

/**
 * Drop image content blocks from a message history, so a side call can run on a
 * text-only model without the images the conversation carried breaking the
 * request. Used by the recap and btw side calls, which reuse the exact messages
 * the session last sent — those can hold `image` blocks (pasted images, an image
 * a Read returned), and neither call needs them: recap summarises "what
 * happened" and btw answers a text question. The classifier renders the
 * transcript to text (never blocks) and the web_fetch reader sends page text, so
 * they need no stripping. A message left with no content becomes a single
 * placeholder text block, so it stays a valid turn on strict providers. Purely
 * structural (any `{ role, content }` message) to stay free of runtime pi
 * imports; assistant messages carry no images and pass through untouched.
 * See `working-docs/decisions/model-policy.md`.
 */
export function stripImageBlocks<M extends { role: string; content: unknown }>(messages: readonly M[]): M[] {
	return messages.map((message) => {
		const content = message.content;
		if (!Array.isArray(content) || !content.some((block) => (block as { type?: string })?.type === "image")) return message;
		const kept = content.filter((block) => (block as { type?: string })?.type !== "image");
		return { ...message, content: kept.length > 0 ? kept : [{ type: "text", text: IMAGE_OMITTED_TEXT }] } as M;
	});
}

/** Join the text blocks of a completion result into one trimmed string. */
export function answerText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

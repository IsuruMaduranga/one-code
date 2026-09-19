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

/** Join the text blocks of a completion result into one trimmed string. */
export function answerText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

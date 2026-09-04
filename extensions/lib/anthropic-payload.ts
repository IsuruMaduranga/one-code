/**
 * Recognising an Anthropic Messages request body inside a `before_provider_request`
 * payload (pure). Shared by context-management (clear_thinking), compaction
 * (its replayed request) and tool-search (deferred tool definitions).
 */

/** Anthropic Messages API shape: `messages` + `max_tokens`, and not an OpenAI `input`. */
export function looksLikeAnthropicRequest(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.messages)) return false;
	if ("input" in record) return false;
	const model = typeof record.model === "string" ? record.model : "";
	return model.includes("claude") || typeof record.max_tokens === "number";
}

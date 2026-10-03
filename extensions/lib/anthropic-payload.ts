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

/**
 * The payload with `betas` added, each once, after the ones pi set. pi-ai 1.0
 * sends `payload.betas` as the final `anthropic-beta` header (it wins over a
 * configured header), so a beta goes here, never into the headers (findings
 * §54). The payload is returned unchanged when nothing is missing.
 */
export function withBetas<T extends Record<string, unknown>>(payload: T, betas: readonly string[]): T {
	const existing: unknown[] = Array.isArray(payload.betas) ? payload.betas : [];
	const missing = [...new Set(betas)].filter((beta) => !existing.includes(beta));
	if (missing.length === 0) return payload;
	return { ...payload, betas: [...existing, ...missing] };
}

/**
 * Recognising an Anthropic Messages request body inside a `before_provider_request`
 * payload (pure). Shared by context-management (clear_thinking), compaction
 * (its replayed request), tool-search (deferred tool definitions) and
 * idle-compact (the cache lifetime).
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

/** Anthropic's beta for a `role: "system"` message after the first one. */
export const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
/** Anthropic's beta for a system message's `clear_at`. */
export const CLEAR_AT_BETA = "mid-conversation-system-clear-at-2026-08-21";
/** Anthropic's beta for reference-form `tool_addition` blocks. */
export const MID_CONVERSATION_TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";

type Message = { role?: unknown; content?: unknown };
type Block = Record<string, unknown> & { cache_control?: unknown };

/** pi's directive-only effort message, which cannot carry a cache mark. */
export function isEmptySystemMessage(message: Message | undefined): boolean {
	return message?.role === "system" && Array.isArray(message.content) && message.content.length === 0;
}

/** A system message with a `clear_at` nudge: a string body, and Anthropic refuses a cache mark on it. */
function isClearAtMessage(message: Message): boolean {
	return message?.role === "system" && "clear_at" in (message as object);
}

/**
 * The messages with pi's conversation cache mark on the last block that can
 * carry it. pi marks the last block of the last message it built; system
 * messages added after it in `before_provider_request` (the context message,
 * the per-turn budget, a tool addition) would otherwise sit outside the mark,
 * so it moves onto the last one, as Claude Code marks its own. pi's empty
 * effort messages and a `clear_at` nudge are skipped over. Unchanged when the
 * mark already sits there or no added system message ends the request.
 */
export function reseatMessageMark<T extends Message>(messages: T[]): T[] {
	let target = messages.length - 1;
	while (target >= 0 && (isEmptySystemMessage(messages[target]) || isClearAtMessage(messages[target]))) target--;
	const tail = messages[target];
	if (tail?.role !== "system" || !Array.isArray(tail.content) || tail.content.length === 0) return messages;
	const tailBlocks = tail.content as Block[];
	if (tailBlocks[tailBlocks.length - 1].cache_control !== undefined) return messages;
	let from = target - 1;
	while (from >= 0 && messages[from]?.role === "system") from--;
	const source = messages[from];
	if (!source || !Array.isArray(source.content) || source.content.length === 0) return messages;
	const sourceBlocks = source.content as Block[];
	const { cache_control, ...unmarked } = sourceBlocks[sourceBlocks.length - 1];
	if (cache_control === undefined) return messages;
	const copy = [...messages];
	copy[from] = { ...source, content: [...sourceBlocks.slice(0, -1), unmarked] };
	copy[target] = { ...tail, content: [...tailBlocks.slice(0, -1), { ...tailBlocks[tailBlocks.length - 1], cache_control }] };
	return copy;
}

/**
 * Whether a request body caches with a one-hour TTL: a breakpoint on the
 * system, the tools or a message carries `cache_control.ttl: "1h"` (pi's long
 * retention on Anthropic, through pi's own compat gating, so the body is the
 * ground truth). OpenAI bodies have no breakpoints and answer false.
 */
export function hasOneHourCache(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const body = payload as { system?: unknown; tools?: unknown; messages?: unknown };
	const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
	const oneHour = (block: unknown) => (block as { cache_control?: { ttl?: unknown } } | null)?.cache_control?.ttl === "1h";
	return (
		list(body.system).some(oneHour) ||
		list(body.tools).some(oneHour) ||
		list(body.messages).some((message) => oneHour(message) || list((message as { content?: unknown } | null)?.content).some(oneHour))
	);
}

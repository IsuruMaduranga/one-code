/**
 * Thinking removed from the turns a compaction keeps. Pure: no pi imports.
 *
 * On Fable 5.1, Opus 5.5 and Sonnet 5.5 a signed thinking block is bound to
 * the conversation before it, and a compaction rewrites that conversation:
 * the kept reply's thinking fails the check on every later request (a 400 on
 * accounts created from 2026-08-31; dropped silently under pi-ai 0.99.2's
 * `drop_block`; findings §46). Blocks may be removed from the start, so the
 * kept turns go out without theirs, from the first request after the
 * compaction on, the same bytes every time. Thinking produced after the
 * compaction binds to that stripped history and stays.
 *
 * The kept turns are the assistant messages older than the latest compaction
 * entry on the session branch (`lib/compaction-boundary.ts`): every message
 * produced since is newer. Text and tool calls stay.
 */

/** APIs whose replayed thinking carries a signature the provider checks (pi-ai's converters). */
const SIGNED_THINKING_APIS = new Set(["anthropic-messages", "bedrock-converse-stream"]);

type ContextMessage = { role: string; timestamp?: number; content?: unknown };

/**
 * The messages with every thinking block (redacted ones included) removed from
 * assistant messages older than `compactionTime`, or undefined when nothing
 * changes: another API, no compaction, or no kept thinking. An assistant
 * message left empty is skipped by pi-ai's converter, as any empty one is.
 */
export function withoutKeptThinking<M extends ContextMessage>(
	messages: readonly M[],
	api: string | undefined,
	compactionTime: number | undefined,
): M[] | undefined {
	if (!signsThinking(api) || compactionTime === undefined || Number.isNaN(compactionTime)) return undefined;
	return stripThinking(messages, (message) => typeof message.timestamp === "number" && message.timestamp < compactionTime);
}

/**
 * The messages with every assistant message's thinking removed, for a request
 * whose system prompt and tools are not the session's (the standalone
 * compaction request): none of its signed blocks would pass the check. The
 * messages unchanged on other APIs.
 */
export function withoutThinking<M extends ContextMessage>(messages: M[], api: string | undefined): M[] {
	return (signsThinking(api) && stripThinking(messages, () => true)) || messages;
}

/** Whether requests on `api` carry signed thinking the provider checks. */
export const signsThinking = (api: string | undefined): boolean => api !== undefined && SIGNED_THINKING_APIS.has(api);

/** The messages with thinking removed from the assistant messages `applies` picks, or undefined when none had any. Copies only on a change. */
function stripThinking<M extends ContextMessage>(messages: readonly M[], applies: (message: M) => boolean): M[] | undefined {
	let result: M[] | undefined;
	messages.forEach((message, i) => {
		if (message.role !== "assistant" || !Array.isArray(message.content) || !message.content.some(isThinking) || !applies(message)) return;
		result ??= messages.slice();
		result[i] = { ...message, content: message.content.filter((block) => !isThinking(block)) };
	});
	return result;
}

const isThinking = (block: unknown): boolean => (block as { type?: unknown } | null)?.type === "thinking";

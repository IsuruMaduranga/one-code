/**
 * Claude Code's per-turn `<total_tokens>` placements, applied to the final
 * request body (pure). One Code stores the line the way it always has, so a
 * resumed session rebuilds the same bytes: a raw marker block after the text
 * of every user message after the first (context-budget's `sticky-append`),
 * and the countdown joined onto every tool result (persisted by
 * system-reminder). This turns those into Claude Code's shapes:
 *
 * - on a model that takes a mid-conversation system message, a system message
 *   with the line after each later user message and after each tool-result
 *   message (the lowest countdown it carries), and on first-party Fable the
 *   `clear_at` nudge after the latter;
 * - elsewhere, Haiku's shape: the framed block before the text of each later
 *   user message (a trailing newline after the frame), and the framed block a
 *   blank line after each tool result's output.
 *
 * The first user message gets the line from the context stack instead
 * (CONTEXT_ORDER.totalTokens), so its marker is dropped. `carrier` is that
 * message's index when the request holds it: a fork's replayed tail does not.
 */

import type { SystemRoleLayout } from "./system-role.ts";

/** The raw line as stored, exactly. */
const LINE = /^<total_tokens>(\d+) tokens left<\/total_tokens>$/;
/** The countdown inside a tool result's text, as pi joins stored blocks with "\n". */
const JOINED = /\n<total_tokens>(\d+) tokens left<\/total_tokens>(?=\n|$)/;

/** Claude Code's Fable nudge after a tool result's budget message. */
export const CLEAR_AT_NUDGE =
	"First privately list what you need next; then request every item that doesn't depend on another's result in this one response.";

export function framedTotalTokens(line: string): string {
	return `<system-reminder>\n${line}\n</system-reminder>`;
}

type Part = { type?: unknown; text?: unknown; content?: unknown; cache_control?: unknown };
type Message = { role?: unknown; type?: unknown; content?: unknown; output?: unknown };

export interface TurnBudgetOptions {
	/** The wire shape; for "anthropic", "responses" and "completions" only. */
	shape: SystemRoleLayout;
	/** True on a model that takes a mid-conversation system message. */
	systemRole: boolean;
	/** The role a system message takes on the OpenAI APIs. */
	role: "system" | "developer";
	/** Index of the message that carries the context stack, if the request holds it. */
	carrier?: number;
	/** Send Claude Code's `clear_at` nudge after a tool result's budget message (first-party Fable). */
	nudge?: boolean;
}

/** Rewrites one tool output: strips the countdown (system role) or frames it (elsewhere). Returns the countdown found. */
function rewriteOutput(text: string, systemRole: boolean): { text: string; left?: number } {
	const match = JOINED.exec(text);
	if (!match) return { text };
	const line = match[0].slice(1);
	const replacement = systemRole ? "" : `\n\n${framedTotalTokens(line)}`;
	return { text: text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length), left: Number(match[1]) };
}

export function withTurnBudgetMessages(payload: Record<string, unknown>, opts: TurnBudgetOptions): Record<string, unknown> | undefined {
	const key = opts.shape === "responses" ? "input" : "messages";
	const messages = payload[key];
	if (!Array.isArray(messages)) return undefined;
	const out: Message[] = [];
	let changed = false;
	/** The lowest countdown of an OpenAI run of tool outputs not yet followed by its message. */
	let pendingLowest: number | undefined;
	const systemMessage = (line: string): Message =>
		opts.shape === "anthropic" ? { role: "system", content: [{ type: "text", text: line }] } : { role: opts.role, content: line };
	const nudgeMessage = (): Message =>
		opts.shape === "anthropic" ? ({ role: "system", content: CLEAR_AT_NUDGE, clear_at: "next_user_message" } as Message) : { role: opts.role, content: CLEAR_AT_NUDGE };

	for (let i = 0; i < messages.length; i++) {
		let message = messages[i] as Message;
		const after: Message[] = [];
		let lowest: number | undefined;
		const note = (left: number | undefined) => {
			if (left !== undefined) lowest = lowest === undefined ? left : Math.min(lowest, left);
		};

		if (message?.role === "user" && Array.isArray(message.content)) {
			let parts = message.content as Part[];
			// The prompt's marker: dropped on the stack's carrier, moved elsewhere.
			const at = parts.findIndex((part) => typeof part?.text === "string" && LINE.test(part.text));
			if (at !== -1) {
				const line = parts[at].text as string;
				parts = parts.filter((_, index) => index !== at);
				if (i !== opts.carrier) {
					if (opts.systemRole) after.push(systemMessage(line));
					else parts = [{ type: opts.shape === "responses" ? "input_text" : "text", text: `${framedTotalTokens(line)}\n` }, ...parts];
				}
			}
			// Anthropic tool results ride the user message as tool_result blocks.
			const before = parts;
			parts = parts.map((part) => {
				if (part?.type !== "tool_result") return part;
				if (typeof part.content === "string") {
					const rewritten = rewriteOutput(part.content, opts.systemRole);
					note(rewritten.left);
					return rewritten.left === undefined ? part : { ...part, content: rewritten.text };
				}
				if (!Array.isArray(part.content)) return part;
				const blocks = part.content as Part[];
				const index = blocks.findIndex((block) => typeof block?.text === "string" && LINE.test(block.text));
				if (index === -1) return part;
				const line = blocks[index].text as string;
				note(Number(LINE.exec(line)?.[1]));
				const next = opts.systemRole ? blocks.filter((_, j) => j !== index) : blocks.map((block, j) => (j === index ? { ...block, text: framedTotalTokens(line) } : block));
				return { ...part, content: next };
			});
			if (parts.every((part, index) => part === before[index])) parts = before;
			if (parts !== message.content) message = { ...message, content: parts };
		} else if ((message?.type === "function_call_output" && typeof message.output === "string") || (message?.role === "tool" && typeof message.content === "string")) {
			const field = message.type === "function_call_output" ? "output" : "content";
			const rewritten = rewriteOutput(message[field] as string, opts.systemRole);
			if (rewritten.left !== undefined) {
				note(rewritten.left);
				message = { ...message, [field]: rewritten.text };
			}
		}

		if (message !== messages[i]) changed = true;
		out.push(message);
		if (lowest !== undefined && opts.systemRole) {
			// On the OpenAI APIs a batch of results is a run of items; one message follows the run.
			const next = messages[i + 1] as Message | undefined;
			const continues = opts.shape !== "anthropic" && (next?.type === "function_call_output" || next?.role === "tool");
			if (continues) {
				pendingLowest = pendingLowest === undefined ? lowest : Math.min(pendingLowest, lowest);
			} else {
				const left = pendingLowest === undefined ? lowest : Math.min(pendingLowest, lowest);
				pendingLowest = undefined;
				after.push(systemMessage(`<total_tokens>${left} tokens left</total_tokens>`));
				if (opts.nudge) after.push(nudgeMessage());
			}
		}
		if (after.length > 0) {
			changed = true;
			out.push(...after);
		}
	}
	if (!changed) return undefined;
	return { ...payload, [key]: opts.shape === "anthropic" ? withMarkOnLastContent(out) : out };
}

/**
 * On Anthropic, pi marks the last block of the last message with content. When
 * a system message added here ends the request's content (only pi's empty
 * effort messages follow), the mark moves onto it, as Claude Code marks its
 * per-turn message; the `clear_at` nudge cannot carry one.
 */
function withMarkOnLastContent(messages: Message[]): Message[] {
	let lastIndex = messages.length - 1;
	while (lastIndex >= 0 && isEmptySystem(messages[lastIndex])) lastIndex--;
	if (lastIndex < 0) return messages;
	const isNudge = (m: Message) => m.role === "system" && typeof m.content === "string" && "clear_at" in (m as object);
	let target = lastIndex;
	while (target >= 0 && isNudge(messages[target])) target--;
	const tail = messages[target];
	if (tail?.role !== "system" || !Array.isArray(tail.content)) return messages;
	const block = (tail.content as Part[])[0];
	if (block?.cache_control !== undefined) return messages;
	// The mark sits on the last block of the message before the added ones.
	let from = target - 1;
	while (from >= 0 && messages[from]?.role === "system") from--;
	const source = messages[from];
	if (!source || !Array.isArray(source.content)) return messages;
	const parts = source.content as Part[];
	const marked = parts[parts.length - 1];
	if (marked?.cache_control === undefined) return messages;
	const { cache_control, ...unmarked } = marked;
	const copy = [...messages];
	copy[from] = { ...source, content: [...parts.slice(0, -1), unmarked] };
	copy[target] = { ...tail, content: [{ ...block, cache_control }] };
	return copy;
}

function isEmptySystem(message: Message): boolean {
	return message?.role === "system" && Array.isArray(message.content) && message.content.length === 0;
}

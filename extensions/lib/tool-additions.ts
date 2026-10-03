/**
 * Claude Code's `tool_addition` for tools that arrive mid-session (pure). One
 * Code stores the arrival as the deferred-tool addendum one-shot
 * (lib/deferred.ts deferredAddendumText), which reads correctly on any model.
 * On a first-party model that takes mid-conversation tool changes, the payload
 * hook lifts that addendum off the message that carries it into a system
 * message right after it: Claude Code's sentence and names, then one
 * reference-form `tool_addition` block per tool, each declared deferred in
 * `tools`. The model can then call the tool without a `tool_search` round
 * trip (findings §55 P1). Elsewhere the addendum stays as it is.
 */

import { wrapReminder } from "./reminders.ts";

/** The first line of the stored addendum; the names follow, one per line. */
export const ADDENDUM_HEAD =
	"Additional deferred tools became available via tool_search since this conversation started (they registered after the first request). Same rules: load with tool_search \"select:<name>\" before calling.";

/** Claude Code's sentence before the names, in its tool-addition message. */
export const TOOLS_AVAILABLE = "The following tools just became available and are ready to use:";

/** Claude Code's betas for a reference-form tool addition in a system message. */
export const TOOL_ADDITION_BETAS = ["mid-conversation-system-2026-04-07", "mid-conversation-tool-changes-2026-07-01"];

/**
 * Whether the model takes Claude Code's reference-form `tool_addition`:
 * first-party Anthropic with pi's catalog flags for mid-conversation system
 * messages and tool changes (Opus 5.5, Sonnet 5.5 and Fable 5.1 among them).
 */
export function supportsToolAdditions(model: { provider?: string; api?: string; compat?: unknown } | undefined): boolean {
	if (!model || model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	const compat = model.compat as { supportsMidConvoSystemMessages?: boolean; supportsMidConvoToolChanges?: boolean } | undefined;
	return compat?.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolChanges === true;
}

/** Every addendum framed in `text` and the names it lists. */
function addendaIn(text: string): Array<{ framed: string; names: string[] }> {
	const found: Array<{ framed: string; names: string[] }> = [];
	const open = wrapReminder(ADDENDUM_HEAD).slice(0, -"\n</system-reminder>".length);
	let from = 0;
	for (;;) {
		const start = text.indexOf(open, from);
		if (start === -1) return found;
		const end = text.indexOf("\n</system-reminder>", start + open.length);
		if (end === -1) return found;
		const names = text
			.slice(start + open.length, end)
			.split("\n")
			.filter((line) => line.length > 0);
		found.push({ framed: text.slice(start, end + "\n</system-reminder>".length), names });
		from = end;
	}
}

/** The names a stored text announces as arriving mid-session (a resume re-activates them). */
export function addendumNames(text: string): string[] {
	return addendaIn(text).flatMap((addendum) => addendum.names);
}

type Part = { type?: unknown; text?: unknown; content?: unknown };
type Message = { role?: unknown; content?: unknown };

/**
 * The payload with every addendum lifted into Claude Code's tool-addition
 * system message after the user message that carried it, and the names lifted
 * (they must be declared deferred in `tools`). Undefined when there is none.
 */
export function withToolAdditions(payload: Record<string, unknown>): { payload: Record<string, unknown>; names: string[] } | undefined {
	const messages = payload.messages;
	if (!Array.isArray(messages)) return undefined;
	const out: Message[] = [];
	const all: string[] = [];
	for (const message of messages as Message[]) {
		if (message?.role !== "user" || !Array.isArray(message.content)) {
			out.push(message);
			continue;
		}
		const names: string[] = [];
		const strip = (text: string): string => {
			let next = text;
			for (const addendum of addendaIn(text)) {
				names.push(...addendum.names);
				// Joined onto a tool result by "\n", or a text block of its own.
				next = next.includes(`\n${addendum.framed}`) ? next.replace(`\n${addendum.framed}`, "") : next.replace(addendum.framed, "");
			}
			return next;
		};
		const content: Part[] = [];
		for (const part of message.content as Part[]) {
			if (part?.type === "text" && typeof part.text === "string") {
				const text = strip(part.text);
				if (text !== part.text && text.length === 0) continue;
				content.push(text === part.text ? part : { ...part, text });
			} else if (part?.type === "tool_result" && typeof part.content === "string") {
				const text = strip(part.content);
				content.push(text === part.content ? part : { ...part, content: text });
			} else {
				content.push(part);
			}
		}
		if (names.length === 0) {
			out.push(message);
			continue;
		}
		const unique = [...new Set(names)];
		all.push(...unique);
		out.push({ ...message, content });
		out.push({
			role: "system",
			content: [
				{ type: "text", text: [TOOLS_AVAILABLE, ...unique].join("\n") },
				...unique.map((name) => ({ type: "tool_addition", tool: { type: "tool_reference", name } })),
			],
		});
	}
	if (all.length === 0) return undefined;
	return { payload: { ...payload, messages: out }, names: [...new Set(all)] };
}

/** A stored message as far as the addendum scan is concerned. */
type StoredEntry = { type?: string; message?: { role?: string; content?: unknown } };

/**
 * The names every addendum persisted into a tool result on the branch
 * announced: on resume they are re-activated, since their addition blocks
 * are rebuilt from the same stored text and the model may call them.
 */
export function addendumNamesOnBranch(branch: readonly StoredEntry[]): string[] {
	const names: string[] = [];
	for (const entry of branch) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Part[]) if (typeof block?.text === "string") names.push(...addendumNames(block.text));
	}
	return [...new Set(names)];
}

/**
 * Claude Code's `tool_addition` for tools that arrive mid-session (pure). One
 * Code stores the arrival as the deferred-tool addendum one-shot
 * (lib/deferred.ts deferredAddendumText), which reads correctly on any model.
 * On a first-party model that takes mid-conversation tool changes, the
 * addendum leaves the message that carries it for a system message right
 * after it: Claude Code's sentence and names, then one reference-form
 * `tool_addition` block per tool, each declared deferred in `tools`. The model
 * can then call the tool without a `tool_search` round trip (findings §55
 * P1). Elsewhere the addendum stays as it is.
 *
 * An addendum is matched as a whole block, never inside other text: in a tool
 * result at `context` time, while the result's blocks are still separate and
 * keyed by its call id (`liftAddenda`), and on a user message as a whole part
 * (a one-shot pinned there).
 */

import { MID_CONVERSATION_SYSTEM_BETA, MID_CONVERSATION_TOOL_CHANGES_BETA, reseatMessageMark } from "./anthropic-payload.ts";
import { byWireCallId, systemRoleLayout, type WireMessage, type WirePart, withoutParts } from "./system-role.ts";

/** The first line of the stored addendum; the names follow, one per line. */
export const ADDENDUM_HEAD =
	"Additional deferred tools became available via tool_search since this conversation started (they registered after the first request). Same rules: load with tool_search \"select:<name>\" before calling.";

/** Claude Code's sentence before the names, in its tool-addition message. */
export const TOOLS_AVAILABLE = "The following tools just became available and are ready to use:";

/** Claude Code's betas for a reference-form tool addition in a system message. */
export const TOOL_ADDITION_BETAS = [MID_CONVERSATION_SYSTEM_BETA, MID_CONVERSATION_TOOL_CHANGES_BETA];

/**
 * Whether the model takes Claude Code's reference-form `tool_addition`:
 * first-party Anthropic on the system-role layout, with pi's catalog flag for
 * mid-conversation tool changes (Opus 5.5, Sonnet 5.5 and Fable 5.1 among them).
 */
export function supportsToolAdditions(model: { id?: string; provider?: string; api?: string; compat?: unknown } | undefined): boolean {
	if (!model || model.provider !== "anthropic" || systemRoleLayout({ id: model.id ?? "", api: model.api ?? "", compat: model.compat }) !== "anthropic") return false;
	return (model.compat as { supportsMidConvoToolChanges?: boolean } | undefined)?.supportsMidConvoToolChanges === true;
}

const OPEN = `<system-reminder>\n${ADDENDUM_HEAD}\n`;
const CLOSE = "\n</system-reminder>";

/** The names a whole framed addendum block lists; undefined for any other text. */
export function addendumNames(text: string): string[] | undefined {
	if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return undefined;
	return text
		.slice(OPEN.length, -CLOSE.length)
		.split("\n")
		.filter((line) => line.length > 0);
}

type StoredBlock = { type?: string; text?: string };
type StoredMessage = { role: string; toolCallId?: string; content?: unknown };

/**
 * The context-time step: each tool result's addendum block leaves the result,
 * its names kept under the call id, for the payload step to send as an
 * addition after that result. Returns the input when nothing changed.
 */
export function liftAddenda<T extends StoredMessage>(messages: T[]): { messages: T[]; byCall: Map<string, string[]> } {
	const byCall = new Map<string, string[]>();
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "toolResult" || !Array.isArray(message.content) || !message.toolCallId) return message;
		const names: string[] = [];
		const kept = (message.content as StoredBlock[]).filter((block) => {
			const found = block?.type === "text" && typeof block.text === "string" ? addendumNames(block.text) : undefined;
			if (found) names.push(...found);
			return !found;
		});
		if (names.length === 0) return message;
		changed = true;
		byCall.set(message.toolCallId, names);
		return { ...message, content: kept };
	});
	return { messages: changed ? out : messages, byCall };
}

/**
 * The Anthropic payload with a tool-addition system message after each user
 * message that answers a call `liftAddenda` lifted an addendum from, or that
 * carries a pinned addendum part (removed). Also returns every name added: they
 * must be declared deferred in `tools`. With `references: false` the message
 * is Claude Code's sentence and names alone, for a request whose tools cannot
 * be referenced (OAuth renames them): the tools are active, so the model can
 * still call them. Undefined when there is none.
 */
export function withToolAdditions(
	payload: Record<string, unknown>,
	byCall: ReadonlyMap<string, readonly string[]>,
	references = true,
): { payload: Record<string, unknown>; names: string[] } | undefined {
	const messages = payload.messages;
	if (!Array.isArray(messages)) return undefined;
	const out: WireMessage[] = [];
	const all = new Set<string>();
	for (const message of messages as WireMessage[]) {
		if (message?.role !== "user" || !Array.isArray(message.content)) {
			out.push(message);
			continue;
		}
		const names: string[] = [];
		const parts = message.content as WirePart[];
		for (const part of parts) {
			const called = part?.type === "tool_result" && typeof part.tool_use_id === "string" ? byWireCallId(byCall, part.tool_use_id) : undefined;
			if (called) names.push(...called);
		}
		const pinnedNames = (part: WirePart) => (part?.type === "text" && typeof part.text === "string" ? addendumNames(part.text) : undefined);
		// A pinned addendum part goes, keeping pi's cache mark; a message it would empty keeps it.
		const kept = withoutParts(parts, (part) => pinnedNames(part) !== undefined) ?? parts;
		if (kept !== parts) for (const part of parts) names.push(...(pinnedNames(part) ?? []));
		if (names.length === 0) {
			out.push(message);
			continue;
		}
		const unique = [...new Set(names)];
		for (const name of unique) all.add(name);
		out.push(kept.length === parts.length ? message : { ...message, content: kept }, {
			role: "system",
			content: [
				{ type: "text", text: [TOOLS_AVAILABLE, ...unique].join("\n") },
				...(references ? unique.map((name) => ({ type: "tool_addition", tool: { type: "tool_reference", name } })) : []),
			],
		});
	}
	if (all.size === 0) return undefined;
	return { payload: { ...payload, messages: reseatMessageMark(out) }, names: [...all] };
}

/** A stored message as far as the addendum scan is concerned. */
type BranchEntry = { type?: string; message?: { role?: string; content?: unknown } };

/**
 * The names every addendum persisted into a tool result on the branch
 * announced: on resume they are re-activated, since their addition blocks
 * are rebuilt from the same stored blocks and the model may call them.
 */
export function addendumNamesOnBranch(branch: readonly BranchEntry[]): string[] {
	const names = new Set<string>();
	for (const entry of branch) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
		for (const block of message.content as StoredBlock[]) {
			for (const name of (typeof block?.text === "string" ? addendumNames(block.text) : undefined) ?? []) names.add(name);
		}
	}
	return [...names];
}

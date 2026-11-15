/**
 * Claude Code's `tool_addition` for tools that arrive mid-session (pure). One
 * Code renders the arrival as the deferred-tool addendum on the request's
 * tail (lib/request/deferred.ts deferredAddendumText), which reads correctly on any model.
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
 * (a one-shot pinned there). Only an addendum this request carries counts, and
 * its tool names come from the facts it was built with (the ledger plan's
 * `carried`, `carriedAddenda`), never from its lines: a line is a name and the
 * profile's or the tool owner's hint for it (lib/request/deferred.ts `listingLine`).
 */

import { acceptsAnthropicWire } from "../../lib/models/model-policy.ts";
import { MID_CONVERSATION_SYSTEM_BETA, MID_CONVERSATION_TOOL_CHANGES_BETA, reseatMessageMark } from "../../lib/request/anthropic-payload.ts";
import { byWireCallId, systemRoleLayout, type WireMessage, type WirePart, withoutParts } from "../../lib/request/system-role.ts";
import { toolSearchResultText } from "../../lib/request/tool-search-text.ts";
import { wrapReminder } from "../../lib/request/reminders.ts";
import type { ToldFact } from "../../lib/request/ledger/records.ts";


/** Claude Code's betas for a reference-form tool addition in a system message. */
export const TOOL_ADDITION_BETAS = [MID_CONVERSATION_SYSTEM_BETA, MID_CONVERSATION_TOOL_CHANGES_BETA];

/**
 * Whether the model takes Claude Code's reference-form `tool_addition`:
 * first-party Anthropic (or a provider whose profile entry lists
 * `tool-additions`) on the system-role layout, with pi's catalog flag for
 * mid-conversation tool changes (Opus 5.5, Sonnet 5.5 and Fable 5.1 among them).
 */
export function supportsToolAdditions(model: { id?: string; provider?: string; api?: string; compat?: unknown } | undefined): boolean {
	if (!model || !acceptsAnthropicWire(model, "tool-additions") || systemRoleLayout({ id: model.id ?? "", api: model.api ?? "", compat: model.compat }) !== "anthropic") return false;
	return (model.compat as { supportsMidConvoToolChanges?: boolean } | undefined)?.supportsMidConvoToolChanges === true;
}

/** The addenda a request carries: each framed block's text, with the tool names it announces. */
export type CarriedAddenda = ReadonlyMap<string, readonly string[]>;

/**
 * The addenda among a request's carried blocks (the ledger plan's `carried`:
 * each block's text with the facts it tells), keyed by the framed text they
 * ride the wire as, with the names of their `tools` facts.
 */
export function carriedAddenda(carried: readonly { text: string; facts: readonly ToldFact[] }[] | undefined): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const block of carried ?? []) {
		if (!block.text.startsWith(`${toolSearchResultText.addendumHead}\n`)) continue;
		const names = block.facts.flatMap((fact) => (fact.kind === "tools" && !fact.removed ? fact.names : []));
		if (names.length > 0) out.set(wrapReminder(block.text), names);
	}
	return out;
}

/** The names a whole framed addendum block the request carries announces; undefined for any other text. */
export function addendumNames(text: string, addenda: CarriedAddenda): readonly string[] | undefined {
	return addenda.get(text);
}

type StoredBlock = { type?: string; text?: string };
type StoredMessage = { role: string; toolCallId?: string; content?: unknown };

/**
 * The context-time step: each tool result's addendum block leaves the result,
 * its names kept under the call id, for the payload step to send as an
 * addition after that result. Returns the input when nothing changed.
 */
export function liftAddenda<T extends StoredMessage>(messages: T[], addenda: CarriedAddenda): { messages: T[]; byCall: Map<string, string[]> } {
	const byCall = new Map<string, string[]>();
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "toolResult" || !Array.isArray(message.content) || !message.toolCallId) return message;
		const names: string[] = [];
		const kept = (message.content as StoredBlock[]).filter((block) => {
			const found = block?.type === "text" && typeof block.text === "string" ? addendumNames(block.text, addenda) : undefined;
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
 * be referenced (`stabilizeDeferredTools` cannot match its names to the
 * registry): the tools are active, so the model can still call them.
 * Undefined when there is none.
 */
export function withToolAdditions(
	payload: Record<string, unknown>,
	byCall: ReadonlyMap<string, readonly string[]>,
	addenda: CarriedAddenda = new Map(),
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
		const pinnedNames = (part: WirePart) => (part?.type === "text" && typeof part.text === "string" ? addendumNames(part.text, addenda) : undefined);
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
				{ type: "text", text: [toolSearchResultText.toolsAvailable, ...unique].join("\n") },
				...(references ? unique.map((name) => ({ type: "tool_addition", tool: { type: "tool_reference", name } })) : []),
			],
		});
	}
	if (all.size === 0) return undefined;
	return { payload: { ...payload, messages: reseatMessageMark(out) }, names: [...all] };
}

/**
 * Redaction of a request's new tail before the ledger records it (pure; the
 * caller supplies the redaction, lib/profile/secrets.ts in the extension).
 *
 * Only the elements from the append point on are touched: everything before
 * it comes from the record, as sent, so the request stays append-only and
 * its cached prefix byte-identical. Only what the harness and the user put
 * into the request is rewritten (user, tool-result, system and developer
 * elements): the model's own messages go back as it wrote them, since a
 * provider may bind signed thinking to them.
 */

import { listKey, type WirePayload } from "./wire.ts";

/** Roles whose content the model wrote: Anthropic and OpenAI's `assistant`, Google's `model`. */
const MODEL_ROLES = new Set(["assistant", "model"]);

/** Whether a list element carries text the harness or the user wrote, in any wire dialect. */
function isRedactable(element: unknown): boolean {
	if (!element || typeof element !== "object") return false;
	const { role, type } = element as { role?: unknown; type?: unknown };
	// A Responses tool result has no role; its calls, reasoning and other items are the model's.
	if (typeof role !== "string") return type === "function_call_output";
	return !MODEL_ROLES.has(role);
}

/** `payload` with `redact` applied to each redactable element at or after `from`; the same object when nothing changed. */
export function redactTail(payload: WirePayload, api: string, from: number, redact: (value: unknown) => unknown): WirePayload {
	const key = listKey(api);
	const list = payload[key];
	if (!Array.isArray(list)) return payload;
	let next: unknown[] | undefined;
	for (let index = from; index < list.length; index++) {
		if (!isRedactable(list[index])) continue;
		const redacted = redact(list[index]);
		if (redacted !== list[index]) (next ??= [...list])[index] = redacted;
	}
	return next ? { ...payload, [key]: next } : payload;
}

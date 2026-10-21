/**
 * The final layout pass over a request's list (findings §52). On Anthropic a
 * system message with content must come after a user message and reach an
 * assistant message, or the end, through system messages only; a request
 * that breaks the rule is a 400, every time, so a session that sends one
 * cannot continue. Several builders put system messages in a list (the
 * stack's system message, `<total_tokens>` countdowns, `tool_addition`
 * notices) and several append to a list built earlier (a side call's prompt
 * after a captured request, a fork's task after its parent's, hook context
 * after a prompt). Instead of each checking what comes after, this pass runs
 * last and makes the layout valid by construction: a run of system messages
 * that a user message follows moves down to just before the next assistant
 * message, or to the end, ahead of the trailing directives pi-ai appends.
 *
 * Only elements from `from` on move (a request's recorded prefix must keep its
 * bytes); the system run that ends the prefix counts as new, since what comes
 * after it is.
 *
 * Pure: no pi imports.
 */
import { isObject } from "./records.ts";
import { isTrailer } from "./wire.ts";

const roleOf = (element: unknown) => (isObject(element) ? element.role : undefined);

/** A system message that is not the directive-only form, which may sit anywhere. */
function isContentSystem(element: unknown): boolean {
	if (roleOf(element) !== "system" || !isObject(element)) return false;
	const content = element.content;
	return Array.isArray(content) || typeof content === "string" ? content.length > 0 : content !== undefined;
}

/** Whether the system run starting at `index` reaches a non-system element that is not an assistant message. */
function strandedAt(list: readonly unknown[], index: number): boolean {
	let next = index + 1;
	while (next < list.length && roleOf(list[next]) === "system") next++;
	return next < list.length && roleOf(list[next]) !== "assistant";
}

/** `list` with no stranded system message at or after `from`: the input itself when nothing moves. */
export function settleSystemMessages<T>(list: readonly T[], api: string, from = 0): readonly T[] {
	if (api !== "anthropic-messages") return list;
	let start = Math.max(0, Math.min(from, list.length));
	while (start > 0 && roleOf(list[start - 1]) === "system") start--;
	if (!list.some((element, index) => index >= start && isContentSystem(element) && strandedAt(list, index))) return list;
	const out = list.slice(0, start);
	let held: T[] = [];
	for (let i = start; i < list.length; i++) {
		const element = list[i];
		if (isContentSystem(element) && strandedAt(list, i)) {
			held.push(element);
			continue;
		}
		if (roleOf(element) === "assistant" && held.length > 0) {
			out.push(...held);
			held = [];
		}
		out.push(element);
	}
	if (held.length > 0) {
		let end = out.length;
		while (end > start && isTrailer(out[end - 1], api)) end--;
		out.splice(end, 0, ...held);
	}
	return out;
}

/** `payload` with its list settled from `from` on; the payload itself when nothing moves. */
export function settlePayload(payload: Record<string, unknown>, api: string, key: string, from = 0): Record<string, unknown> {
	const list = payload[key];
	if (!Array.isArray(list)) return payload;
	const settled = settleSystemMessages(list, api, from);
	return settled === list ? payload : { ...payload, [key]: settled };
}

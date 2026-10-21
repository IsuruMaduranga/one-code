/**
 * The last step before a request goes out (design.md section 5, step 6). Each
 * returned problem is a bug: tests treat any as fatal; at runtime the caller
 * drops the offending block and logs it, so a bookkeeping bug costs one stale
 * announcement, never a 400.
 *
 * Pure: no pi imports.
 */
import { contentHash, listKey, type RecordedRequest, type WirePayload } from "./wire.ts";

export type Problem =
	/** A tool_reference, tool_addition or tool_removal names a tool `tools` does not declare. */
	| { kind: "undeclared"; name: string; index: number }
	/** Anthropic: a system message with content followed by something other than an assistant message (findings §52). */
	| { kind: "stranded-system"; index: number }
	/** An element above the append point differs from the record. */
	| { kind: "prefix"; index: number };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The names `tools` declares: Anthropic and Responses `name`, Chat Completions `function.name`. */
function declaredNames(tools: unknown): Set<string> {
	const names = new Set<string>();
	if (!Array.isArray(tools)) return names;
	for (const tool of tools) {
		if (!isObject(tool)) continue;
		const name = typeof tool.name === "string" ? tool.name : isObject(tool.function) ? tool.function.name : undefined;
		if (typeof name === "string") names.add(name);
	}
	return names;
}

/** Every tool name a block references, at any depth: `tool_addition` and `tool_removal` wrap a `tool_reference`. */
function referencedNames(value: unknown, into: Set<string>): Set<string> {
	if (Array.isArray(value)) for (const item of value) referencedNames(item, into);
	else if (isObject(value)) {
		if (value.type === "tool_reference" && typeof value.name === "string") into.add(value.name);
		for (const item of Object.values(value)) referencedNames(item, into);
	}
	return into;
}

const roleOf = (element: unknown) => (isObject(element) ? element.role : undefined);

const hasContent = (element: unknown) => {
	const content = isObject(element) ? element.content : undefined;
	return Array.isArray(content) || typeof content === "string" ? content.length > 0 : content !== undefined;
};

/** Anthropic: each system message with content must reach an assistant message, or the end, through system messages only. */
function strandedSystems(list: readonly unknown[]): number[] {
	const stranded: number[] = [];
	list.forEach((element, index) => {
		if (roleOf(element) !== "system" || !hasContent(element)) return;
		let next = index + 1;
		while (next < list.length && roleOf(list[next]) === "system") next++;
		if (next < list.length && roleOf(list[next]) !== "assistant") stranded.push(index);
	});
	return stranded;
}

export function validateRequest(payload: WirePayload, api: string, recorded?: RecordedRequest): Problem[] {
	const problems: Problem[] = [];
	const value = payload[listKey(api)];
	const list: unknown[] = Array.isArray(value) ? value : [];

	const declared = declaredNames(payload.tools);
	list.forEach((element, index) => {
		for (const name of referencedNames(element, new Set())) if (!declared.has(name)) problems.push({ kind: "undeclared", name, index });
	});

	if (api === "anthropic-messages") for (const index of strandedSystems(list)) problems.push({ kind: "stranded-system", index });

	if (recorded) {
		for (let index = 0; index < recorded.list.length; index++) {
			if (index >= list.length || contentHash(list[index]) !== recorded.hashes[index]) problems.push({ kind: "prefix", index });
		}
	}
	return problems;
}

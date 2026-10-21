/**
 * The last step before a request goes out (design.md section 5, step 6). Each
 * returned problem is a bug: tests treat any as fatal; at runtime the caller
 * drops the offending block (`repairRequest`) and logs it, so a bookkeeping
 * bug costs one stale announcement, never a 400.
 *
 * Pure: no pi imports.
 */
import { isObject, type ToldFact } from "./records.ts";
import { declarationsOf, listKey, toolName, type WirePayload } from "./wire.ts";

export type Problem =
	/** A tool_reference, tool_addition or tool_removal names a tool `tools` does not declare. */
	| { kind: "undeclared"; name: string; index: number }
	/** Anthropic: a system message with content followed by something other than an assistant message (findings §52). */
	| { kind: "stranded-system"; index: number };

/** The names the payload declares, in any API's shape. */
function declaredNames(payload: WirePayload): Set<string> {
	const names = new Set<string>();
	for (const tool of declarationsOf(payload)) {
		const name = toolName(tool);
		if (name !== undefined) names.add(name);
	}
	return names;
}

/** The tool a `tool_reference` block names: `name` in a `tool_addition`, `tool_name` in a tool result. */
function referenceName(block: Record<string, unknown>): string | undefined {
	if (block.type !== "tool_reference") return undefined;
	const name = block.name ?? block.tool_name;
	return typeof name === "string" ? name : undefined;
}

/** Every tool name a block references, at any depth: `tool_addition` and `tool_removal` wrap a `tool_reference`. */
function referencedNames(value: unknown, into: Set<string>): Set<string> {
	if (Array.isArray(value)) for (const item of value) referencedNames(item, into);
	else if (isObject(value)) {
		const name = referenceName(value);
		if (name !== undefined) into.add(name);
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

export function validateRequest(payload: WirePayload, api: string): Problem[] {
	const problems: Problem[] = [];
	const value = payload[listKey(api)];
	const list: unknown[] = Array.isArray(value) ? value : [];

	const declared = declaredNames(payload);
	list.forEach((element, index) => {
		for (const name of referencedNames(element, new Set())) if (!declared.has(name)) problems.push({ kind: "undeclared", name, index });
	});

	if (api === "anthropic-messages") for (const index of strandedSystems(list)) problems.push({ kind: "stranded-system", index });
	return problems;
}

/** `value` without the `tool_reference` blocks naming `names` (and the `tool_addition` wrapping one); undefined when a container would empty. */
function withoutReferences(value: unknown, names: ReadonlySet<string>): unknown {
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			if (isObject(item) && (item.type === "tool_addition" || item.type === "tool_removal") && referencedNames(item, new Set()).size > 0 && [...referencedNames(item, new Set())].every((name) => names.has(name))) return [];
			if (isObject(item) && names.has(referenceName(item) ?? "")) return [];
			return [withoutReferences(item, names)];
		});
	}
	if (!isObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = withoutReferences(item, names);
	return out;
}

/**
 * The payload with every flagged problem removed, for a production request
 * (a test treats any problem as fatal instead): references to undeclared
 * tools are dropped, and so is a stranded system message.
 */
export function repairRequest(payload: WirePayload, api: string, problems: readonly Problem[]): WirePayload {
	const key = listKey(api);
	const value = payload[key];
	if (!Array.isArray(value) || problems.length === 0) return payload;
	const undeclared = new Set(problems.flatMap((problem) => (problem.kind === "undeclared" ? [problem.name] : [])));
	const stranded = new Set(problems.flatMap((problem) => (problem.kind === "stranded-system" ? [problem.index] : [])));
	let list = value.filter((_, index) => !stranded.has(index));
	if (undeclared.size > 0) {
		list = (withoutReferences(list, undeclared) as unknown[]).filter(
			(element) => !(isObject(element) && element.role === "system" && Array.isArray(element.content) && element.content.length === 0 && element.output_config === undefined),
		);
	}
	return { ...payload, [key]: list };
}

/**
 * What a repaired request still delivers, so its record does not count a
 * dropped block as sent: the consumed pending items whose text is still in
 * the payload, and the callable-tool facts without a tool whose
 * `tool_addition` was dropped (a listing for tool_search names tools the
 * request need not declare).
 */
export function deliveredAfterRepair(
	payload: WirePayload,
	api: string,
	delivered: { consumed: readonly string[]; facts: readonly ToldFact[] },
	pending: readonly { id: string; text: string }[],
): { consumed: string[]; facts: ToldFact[] } {
	const sent = JSON.stringify(payload);
	const texts = new Map(pending.map((item) => [item.id, item.text]));
	const referenced = referencedNames(payload[listKey(api)], new Set());
	const declared = declaredNames(payload);
	const facts = delivered.facts.flatMap((fact): ToldFact[] => {
		if (fact.kind !== "tools" || !fact.callable) return [fact];
		const names = fact.names.filter((name) => declared.has(name) && referenced.has(name));
		return names.length > 0 ? [{ ...fact, names }] : [];
	});
	return {
		consumed: delivered.consumed.filter((id) => {
			const text = texts.get(id);
			return text === undefined || sent.includes(JSON.stringify(text).slice(1, -1));
		}),
		facts,
	};
}

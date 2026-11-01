/**
 * Real elements of a pi 1.4.0 Responses request (fixtures/responses-pi-1.4.0.json),
 * for the tests of the ledger splice, tool_search loads and forks on pi
 * 1.4.0's shape: the starting tools in an `additional_tools` item at the head
 * of the input (findings §78).
 */
import fixture from "../fixtures/responses-pi-1.4.0.json" with { type: "json" };

export type Item = Record<string, unknown>;

export const real = fixture as unknown as Record<string, Item> & { headItem: Item & { tools: Item[] } };

/** pi's head `additional_tools` item, declaring `tools`. */
export const toolsItem = (tools: Item[]): Item => ({ ...real.headItem, tools });

/** Every name a Responses body declares, once per declaration: its top-level `tools`, then its `additional_tools` items. */
export const declaredNames = (payload: Item): string[] => [
	...((payload.tools as Item[] | undefined) ?? []).map((tool) => String(tool.name)),
	...(payload.input as Item[]).flatMap((item) => (item.type === "additional_tools" ? (item.tools as Item[]).map((tool) => String(tool.name)) : [])),
];

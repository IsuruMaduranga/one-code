/**
 * The deferral channel, in a module of its own so a light caller
 * (lib/profile/feature.ts, loaded by every extension) can emit on it without importing
 * lib/request/deferred.ts and the ledger behind it. lib/request/deferred.ts re-exports both.
 * Any extension can defer its own tools by emitting on DEFER_CHANNEL with
 * `{ name, keywords?, hint? }`; tool-search is the one listener.
 */

import { brandedId } from "../profile/brand.mjs";
import type { DeferrableTool } from "./deferrable-tools.ts";

export const DEFER_CHANNEL = brandedId("defer-tool");

type DeferBus = { emit(channel: string, data: unknown): void };

export interface DeferRequest {
	name: string;
	/** Extra search terms beyond the tool's name and description. */
	keywords?: string[];
	/**
	 * One line on when to load the tool, for its deferred-listing line
	 * (`name: hint`) when the profile has no hint for that name; a profile
	 * hint always wins. Listing text only: no other field of the tool changes.
	 */
	hint?: string;
}

/**
 * Put one of the base's own tools behind `tool_search`. The name is typed
 * against `DEFERRABLE_TOOLS`, the list a profile's listing hints are keyed by,
 * so a base tool cannot be deferred without being on it (a source test keeps
 * every base module off the raw channel).
 */
export function deferBaseTool(events: DeferBus, name: DeferrableTool, keywords: string[]): void {
	events.emit(DEFER_CHANNEL, { name, keywords } satisfies DeferRequest);
}

/** Defer a tool the base does not list: an MCP server's tool, or a request the parent already made, passed on to a child. */
export function deferTool(events: DeferBus, request: DeferRequest): void {
	events.emit(DEFER_CHANNEL, request);
}

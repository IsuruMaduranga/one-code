/**
 * What tool-search needs from a profile (types only): the tool_search tool's
 * own words, and the deferred-tool listing's per-tool hints and closing
 * paragraph. Its results, the listing's head and the reminders about
 * deferred tools are the base's (lib/request/tool-search-text.ts).
 */

import type { DeferrableTool } from "../../lib/request/deferrable-tools.ts";

export interface ToolSearchText {
	description: string;
	promptSnippet: string;
	params: { query: string; maxResults: string };
	/**
	 * Per deferred tool, the one line on when to load it, shown after its name
	 * in the listing (`name: hint`). A tool with none is listed by name. Keyed
	 * by the base's deferrable tools, so a renamed or no longer deferred tool
	 * is a type error here; a product's own tools carry their hint on their
	 * `DeferRequest` instead.
	 */
	listingHints?: Partial<Record<DeferrableTool, string>>;
	/** The paragraph after the listing's names, on loading a tool the next step needs. */
	listingClose?: string;
}

/**
 * What tool-search needs from a profile (types only): the tool_search tool's
 * own words, and the deferred-tool listing's per-tool hints and closing
 * paragraph. Its results, the listing's head and the reminders about
 * deferred tools are the base's (lib/request/tool-search-text.ts).
 */

export interface ToolSearchText {
	description: string;
	promptSnippet: string;
	params: { query: string; maxResults: string };
	/**
	 * Per deferred tool, the one line on when to load it, shown after its name
	 * in the listing (`name: hint`). A tool with none is listed by name.
	 */
	listingHints?: Readonly<Record<string, string>>;
	/** The paragraph after the listing's names, on loading a tool the next step needs. */
	listingClose?: string;
}

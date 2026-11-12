/**
 * What tool-search needs from a profile (types only): the tool_search tool's
 * own words. Its results, the deferred-tool listing and the reminders about
 * deferred tools are the base's (lib/request/tool-search-text.ts).
 */

export interface ToolSearchText {
	description: string;
	promptSnippet: string;
	params: { query: string; maxResults: string };
}

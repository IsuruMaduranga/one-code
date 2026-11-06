/**
 * What tool-search needs from a profile (types only): the tool_search tool's
 * words and results, and the reminders about deferred tools
 * (lib/deferred.ts, lib/tool-additions.ts). Each listing is a head line
 * then one name per line, a format the base keeps (it reads the addendum
 * back by its head).
 */


/** What a tool_search call did, by tool name as the model wrote it. */
export interface SearchOutcome {
	/** Loaded by this call. */
	added: string[];
	/** Callable already. */
	already: string[];
	/** Matched but left out by this session's tool list. */
	refused: string[];
	/** Asked for by name but not a deferred tool. */
	missing: string[];
	/** Asked for by name but withdrawn for the current model. */
	withdrawn: string[];
}

export interface ToolSearchText {
	description: string;
	promptSnippet: string;
	params: { query: string; maxResults: string };
	result(outcome: SearchOutcome): string;
	/** Nothing matched; `loadable` lists every deferred tool. */
	noMatch(p: { query: string; missing: string[]; withdrawn: string[]; loadable: string[] }): string;
	/** In place of the plain success sentence once the loaded tools ride as references. */
	toolLoaded: string;
	/** The head lines of the listing on the first message, of a later addition, and of a removal. */
	listingHead: string;
	addendumHead: string;
	removedHead: string;
	/** The sentence before the names in a reference-form tool addition. */
	toolsAvailable: string;
	/** A deferred tool called before it was loaded. */
	missReminder(p: { name: string }): string;
	/** A tool withdrawn for the current model was called. */
	withheldMiss(p: { name: string }): string;
	/** A declared tool this session no longer runs was called. */
	unavailable(p: { name: string }): string;
	/** A resumed session lists deferred tools but has no tool_search to load them. */
	loaderUnavailable: string;
}

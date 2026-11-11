/**
 * The words of tool_search's results and of the deferred-tool listing and
 * reminders: Claude Code's listing with our tool name and the dispatcher's
 * real error text, and our own results and reminders. The tool's own words
 * (its description and parameters) are the profile's
 * (request/tool-search/text.ts).
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

/** The notes about names that were not loadable, each starting with a space. */
function notFoundNote({ missing, withdrawn }: Pick<SearchOutcome, "missing" | "withdrawn">): string {
	return (
		(missing.length > 0 ? ` Not found (not deferred tool names — check spelling, or search by keyword instead of \`select:\`): ${missing.join(", ")}.` : "") +
		(withdrawn.length > 0 ? ` Withdrawn for the current model (do not retry): ${withdrawn.join(", ")}.` : "")
	);
}

export const toolSearchResultText = {
	result: (outcome: SearchOutcome): string =>
		(
			[
				outcome.added.length > 0 ? `Loaded ${outcome.added.join(", ")}. These tools are now callable.` : "",
				outcome.already.length > 0 ? `Already loaded: ${outcome.already.join(", ")}.` : "",
			]
				.filter(Boolean)
				.join(" ") +
			(outcome.refused.length > 0 ? ` Could not load ${outcome.refused.join(", ")}: this session's tool list (pi's --tools) leaves them out, so they cannot be called.` : "") +
			notFoundNote(outcome)
		).trim(),
	/** Nothing matched; `loadable` lists every deferred tool. */
	noMatch: ({ query, missing, withdrawn, loadable }: { query: string; missing: string[]; withdrawn: string[]; loadable: string[] }): string =>
		`No tools matched "${query}".${notFoundNote({ missing, withdrawn })} Tools that can be loaded: ${loadable.join(", ") || "(none)"}`,
	/** In place of the plain success sentence once the loaded tools ride as references. */
	toolLoaded: "Tool loaded.",
	/** The head lines of the listing on the first message, of a later addition, and of a removal. */
	listingHead:
		'The following deferred tools are available via tool_search. Their schemas are NOT loaded — calling one directly fails with "Tool <name> not found" until you load it. Use tool_search with query "select:<name>[,<name>...]" to load tool schemas before calling them (once loaded, a tool stays callable for the rest of the session):',
	addendumHead:
		'Additional deferred tools became available via tool_search since this conversation started (they registered after the first request). Same rules: load with tool_search "select:<name>" before calling.',
	removedHead: "The following deferred tools are no longer available. tool_search cannot load them and calls to them fail; do not use them:",
	/** The sentence before the names in a reference-form tool addition. */
	toolsAvailable: "The following tools just became available and are ready to use:",
	/** A deferred tool called before it was loaded. */
	missReminder: ({ name }: { name: string }): string =>
		[
			`\`${name}\` is a deferred tool — its schema is not loaded, so that call failed with "Tool ${name} not found".`,
			`Load it first with tool_search (\`select:${name}\`), then reissue the call. It stays callable for the rest of the session once loaded.`,
		].join(" "),
	/** A tool withdrawn for the current model was called. */
	withheldMiss: ({ name }: { name: string }): string =>
		`\`${name}\` failed with "Tool ${name} not found" because it was withdrawn for the current model — it is not a deferred tool you can load with tool_search. Do not retry it; continue without it.`,
	/** A declared tool this session no longer runs was called. */
	unavailable: ({ name }: { name: string }): string =>
		`\`${name}\` failed with "Tool ${name} not found" because it is no longer available in this session, although it is still declared. Do not retry it; continue without it.`,
	/** A resumed session lists deferred tools but has no tool_search to load them. */
	loaderUnavailable:
		"tool_search is not available in this session, so it cannot load the deferred tools listed earlier in this conversation. Use only the tools defined for this session.",
};

/** `tool_search`'s plain success sentence, alone on its line: what `result` writes when every name loaded. */
export const LOADED_SENTENCE = /^Loaded [^\n]*\. These tools are now callable\.(?=\n|$)/;

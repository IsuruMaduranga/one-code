/**
 * One Code's tool-search text (the profile's `text.toolSearch`): Claude
 * Code's ToolSearch description and deferred-tool listing with One Code's
 * tool name and its dispatcher's real error text, and One Code's own results
 * and reminders.
 */

import type { SearchOutcome, ToolSearchText } from "../../extensions/tool-search/text.ts";
import { type ToolPassages, withoutOff } from "../live-tools.ts";
import type { LiveTools } from "../../extensions/lib/live-tools.ts";

/** The notes about names that were not loadable, each starting with a space. */
function notFoundNote({ missing, withdrawn }: Pick<SearchOutcome, "missing" | "withdrawn">): string {
	return (
		(missing.length > 0 ? ` Not found (not deferred tool names — check spelling, or search by keyword instead of \`select:\`): ${missing.join(", ")}.` : "") +
		(withdrawn.length > 0 ? ` Withdrawn for the current model (do not retry): ${withdrawn.join(", ")}.` : "")
	);
}

const DESCRIPTION =
	"Fetches full schema definitions for deferred tools so they can be called.\n\nDeferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and loads the matched tools' full schemas so they become callable exactly like any tool defined at the top of the prompt.\n\nQuery forms:\n- `select:web_fetch,notebook_edit` — fetch these exact tools by name\n- `notebook jupyter` — keyword search, up to max_results best matches\n- `+slack send` — require \"slack\" in the name, rank by remaining terms";

/** The example names both tools: a placeholder when either is off. */
const EXAMPLE_SELECT = [["`select:web_fetch,notebook_edit`", "`select:<name>,<name>`"]] as const;

const DESCRIPTION_PASSAGES: ToolPassages = {
	web_fetch: EXAMPLE_SELECT,
	notebook_edit: EXAMPLE_SELECT,
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const toolSearchText = (live: LiveTools): ToolSearchText => ({
	description: withoutOff(DESCRIPTION, live, DESCRIPTION_PASSAGES),
	promptSnippet: "Load additional tool schemas on demand",
	params: {
		query: "Tool names (`select:a,b`) or keywords describing the capability needed",
		maxResults: "Maximum tools to load (default 5)",
	},
	result: (outcome) =>
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
	noMatch: ({ query, missing, withdrawn, loadable }) =>
		`No tools matched "${query}".${notFoundNote({ missing, withdrawn })} Tools that can be loaded: ${loadable.join(", ") || "(none)"}`,
	toolLoaded: "Tool loaded.",
	listingHead:
		'The following deferred tools are available via tool_search. Their schemas are NOT loaded — calling one directly fails with "Tool <name> not found" until you load it. Use tool_search with query "select:<name>[,<name>...]" to load tool schemas before calling them (once loaded, a tool stays callable for the rest of the session):',
	addendumHead:
		'Additional deferred tools became available via tool_search since this conversation started (they registered after the first request). Same rules: load with tool_search "select:<name>" before calling.',
	removedHead: "The following deferred tools are no longer available. tool_search cannot load them and calls to them fail; do not use them:",
	toolsAvailable: "The following tools just became available and are ready to use:",
	missReminder: ({ name }) =>
		[
			`\`${name}\` is a deferred tool — its schema is not loaded, so that call failed with "Tool ${name} not found".`,
			`Load it first with tool_search (\`select:${name}\`), then reissue the call. It stays callable for the rest of the session once loaded.`,
		].join(" "),
	withheldMiss: ({ name }) =>
		`\`${name}\` failed with "Tool ${name} not found" because it was withdrawn for the current model — it is not a deferred tool you can load with tool_search. Do not retry it; continue without it.`,
	unavailable: ({ name }) =>
		`\`${name}\` failed with "Tool ${name} not found" because it is no longer available in this session, although it is still declared. Do not retry it; continue without it.`,
	loaderUnavailable:
		"tool_search is not available in this session, so it cannot load the deferred tools listed earlier in this conversation. Use only the tools defined for this session.",
});

/**
 * One Code's tool_search words (the profile's `text.toolSearch`): Claude
 * Code's ToolSearch description with One Code's tool name, and the
 * parameter words.
 */

import type { LiveTools, ToolSearchText } from "../../../extensions/sdk/profile.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

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
});

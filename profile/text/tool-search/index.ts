/**
 * One Code's tool_search words (the profile's `text.toolSearch`): Claude
 * Code's ToolSearch description with One Code's tool name, the parameter
 * words, and the deferred-tool listing's per-tool hints and closing
 * paragraph. The hints are Claude Code's with One Code's tool names; where a
 * hint names something One Code does not have (a scheduled-tasks file, an
 * agent addressed by name, a teammate, an edit tool that refuses notebooks)
 * that clause is left out. One Code's own deferred tools (task_output,
 * artifact, lsp_diagnostics) and MCP tools have none and are listed by name.
 */

import type { DeferrableTool, LiveTools, ToolSearchText } from "../../../extensions/sdk/profile.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

const DESCRIPTION =
	"Fetches full schema definitions for deferred tools so they can be called.\n\nDeferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and loads the matched tools' full schemas so they become callable exactly like any tool defined at the top of the prompt.\n\nQuery forms:\n- `select:web_fetch,notebook_edit` — fetch these exact tools by name\n- `notebook jupyter` — keyword search, up to max_results best matches\n- `+slack send` — require \"slack\" in the name, rank by remaining terms";

/** The example names both tools: a placeholder when either is off. */
const EXAMPLE_SELECT = [["`select:web_fetch,notebook_edit`", "`select:<name>,<name>`"]] as const;

const DESCRIPTION_PASSAGES: ToolPassages = {
	web_fetch: EXAMPLE_SELECT,
	notebook_edit: EXAMPLE_SELECT,
};

/** When to load each deferred tool, one line after its name in the listing. */
const LISTING_HINTS: Readonly<Partial<Record<DeferrableTool, string>>> = {
	cron_create:
		"When you are about to agree to do something at a set time or at fixed intervals, use it and not a promise in your reply, which nothing would carry out; to catch a change as it happens, use monitor.",
	cron_delete: "When you are about to stop a job that cron_create scheduled, use it.",
	cron_list: "When you are about to say which jobs are scheduled or when they next run, use it.",
	enter_plan_mode: "When you are about to start writing code for a task that is not simple, use it and not a start on the edits, so that the user approves the approach first.",
	enter_worktree: "When the user or the project's instructions have said to work in a worktree and you are about to begin, use it; for plain branch work use git and not this.",
	exit_plan_mode: "When you are in plan mode, your plan is ready and you are about to ask whether to proceed, use it and not a question, in plain text or through ask_user_question.",
	exit_worktree: "When the user asks to leave a worktree that enter_worktree put this session in, use it; do not call it on your own initiative.",
	list_mcp_resources:
		"When you are about to say what resources the configured MCP servers offer, or need a resource's URI to read with read_mcp_resource, use it; it lists resources, not a server's tools.",
	monitor: "When you are about to check a log, process or job again and again to catch each new event, use it and not repeated bash calls or sleeps.",
	notebook_edit: "When you are about to change, add or delete a cell of a Jupyter notebook (.ipynb), use it and not a text edit of the file.",
	read_mcp_resource_dir:
		"When you are about to list what is inside a directory resource on an MCP server, use it; it lists one level per call and works only on servers that support directory listing; for a file resource use read_mcp_resource.",
	read_mcp_resource:
		"When you are about to read the contents of one resource on an MCP server and you know the server name and the resource URI, use it; to find URIs use list_mcp_resources, and for a directory resource use read_mcp_resource_dir.",
	SendMessage: "When you are about to tell, ask or answer another agent, use it and not plain text, which other agents cannot see.",
	task_stop: "When you are about to end a background task or a background agent that is still running, use it with the task's id.",
	web_fetch: "When you are about to read a public web page, use it; it cannot reach most private or authenticated pages, or localhost.",
	web_search: "When you are about to answer from memory on something recent or past your knowledge cutoff, use it and not memory alone.",
};

/**
 * Hints for a session whose model is not Claude-family, in place of the ones
 * above. Claude reads the plan-mode hint as advice; other models (GPT-6.1 Sol,
 * seen in a real session) obey it literally and enter plan mode unasked on an
 * ordinary task, so they are told to enter it only when asked.
 */
const LISTING_HINTS_OTHER_MODELS: Readonly<Partial<Record<DeferrableTool, string>>> = {
	enter_plan_mode: "When the user asks for a plan before any change, or asks to enter plan mode, use it; do not enter plan mode on your own initiative.",
};

/** Per tool, the clauses of other tools' hints that name it. */
const HINT_PASSAGES: ToolPassages = {
	monitor: ["; to catch a change as it happens, use monitor"],
	bash: [["not repeated bash calls or sleeps", "not repeated calls or sleeps"]],
	ask_user_question: [", in plain text or through ask_user_question"],
	enter_worktree: [["a worktree that enter_worktree put this session in", "a worktree this session entered"]],
	read_mcp_resource: [[", or need a resource's URI to read with read_mcp_resource, use it", ", use it"], "; for a file resource use read_mcp_resource"],
	read_mcp_resource_dir: [", and for a directory resource use read_mcp_resource_dir"],
};

const LISTING_CLOSE =
	"When the step in front of you is one that an entry in this list is made for, and that tool is not loaded yet, load it as your next step. That holds even if you could do the step another way, with a general tool or in a plain-text reply. Loading runs nothing: it brings the tool's definition into the conversation, and you choose how to do the step once you have read it.";

/** A hint table with the clauses naming a tool that is off cut. The entries come from a typed table, so its keys are the base's deferrable tools. */
const hintsFor = (table: Readonly<Partial<Record<DeferrableTool, string>>>, live: LiveTools) =>
	Object.fromEntries(Object.entries(table).map(([tool, hint]) => [tool, withoutOff(hint, live, HINT_PASSAGES)])) as Partial<Record<DeferrableTool, string>>;

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const toolSearchText = (live: LiveTools): ToolSearchText => ({
	description: withoutOff(DESCRIPTION, live, DESCRIPTION_PASSAGES),
	promptSnippet: "Load additional tool schemas on demand",
	params: {
		query: "Tool names (`select:a,b`) or keywords describing the capability needed",
		maxResults: "Maximum tools to load (default 5)",
	},
	listingHints: hintsFor(LISTING_HINTS, live),
	listingHintsOtherModels: hintsFor(LISTING_HINTS_OTHER_MODELS, live),
	listingClose: LISTING_CLOSE,
});

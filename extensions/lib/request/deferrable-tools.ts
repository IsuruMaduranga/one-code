/**
 * The base tools that sit behind `tool_search` by default: the one list of
 * their names (a leaf, so the profile's text types can import it through
 * extensions/sdk/profile.ts). A profile's per-tool listing hints are keyed by
 * `DeferrableTool`, so the typecheck fails the profile when the base renames
 * a tool or stops deferring it. A base extension defers its tools through
 * `deferBaseTool` (deferred-channel.ts), whose name is typed against this
 * union (test/unit/defer-channel-source.test.ts keeps every base module off
 * the raw channel), and test/unit/deferrable-tools.test.ts checks the list
 * holds no name the extensions do not announce.
 *
 * Not in the list: a product's own tools (their owner gives each a hint on
 * its `DeferRequest`), MCP server tools (listed by name) and any tool a
 * profile defers with its `deferred` switch.
 */

export const DEFERRABLE_TOOLS = [
	"SendMessage",
	"SubagentHandback",
	"artifact",
	"cron_create",
	"cron_delete",
	"cron_list",
	"enter_plan_mode",
	"enter_worktree",
	"exit_plan_mode",
	"exit_worktree",
	"list_mcp_resources",
	"lsp_diagnostics",
	"monitor",
	"notebook_edit",
	"read_mcp_resource",
	"read_mcp_resource_dir",
	"task_create",
	"task_get",
	"task_list",
	"task_output",
	"task_stop",
	"task_update",
	"url_context",
	"web_fetch",
	"web_search",
] as const;

export type DeferrableTool = (typeof DEFERRABLE_TOOLS)[number];

/** The three tools of the MCP resources feature, announced together once a server is connected. */
export const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir"] as const satisfies readonly DeferrableTool[];

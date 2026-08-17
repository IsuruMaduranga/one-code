/**
 * Channel the mcp extension uses to publish its live tool definitions so the
 * subagent runner can inject them into in-process child sessions as customTools —
 * the child then reaches MCP servers through the parent's already-open
 * connections instead of connecting its own (Claude Code's shared-services model).
 *
 * The definitions' execute() closes over the parent mcp extension's live
 * connection map, so they must only ever be used in the same process.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const MCP_TOOLS_CHANNEL = "one-code:mcp-tools";

export interface McpToolsPayload {
	/** Every MCP tool currently registered on the parent session (re-published as servers connect). */
	tools: ToolDefinition[];
}

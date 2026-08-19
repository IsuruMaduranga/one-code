/**
 * Cross-extension MCP status channel (pure types/constants, no pi imports).
 *
 * jiti gives every extension file its own module instance, so the /plugins
 * panel cannot import the mcp extension's connection state directly. Instead:
 * the panel emits MCP_STATUS_REQUEST_CHANNEL, and the mcp extension replies on
 * MCP_STATUS_CHANNEL with a snapshot (same data its /mcp command formats).
 * The reply is synchronous and in-process, but the request/reply shape also
 * covers the ordering problem — the bus does not replay, and the panel opens
 * long after the mcp extension's connect events fired.
 */

export const MCP_STATUS_REQUEST_CHANNEL = "one-code:mcp-status-request";
export const MCP_STATUS_CHANNEL = "one-code:mcp-status";

export type McpStatusKind = "connected" | "failed" | "authNeeded" | "connecting";

export interface McpServerStatus {
	name: string;
	status: McpStatusKind;
	/** Failure reason / missing env var, for the row's detail text. */
	detail?: string;
	toolCount?: number;
	/** Set when a plugin's .mcp.json contributed this server. */
	pluginName?: string;
	/** Where the server was configured (".mcp.json", "~/.claude.json", plugin path…). */
	source?: string;
}

export interface McpStatusEvent {
	servers: McpServerStatus[];
	/** False while the startup connect is still in flight. */
	settled: boolean;
}

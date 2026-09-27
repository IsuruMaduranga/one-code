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
	/**
	 * True on the final publish, when every configured server has connected or
	 * failed (also emitted with zero tools when no servers are configured).
	 * Consumers spawning children early can wait for this instead of snapshotting
	 * a still-connecting set.
	 */
	settled?: boolean;
}

/** How long a child spawned while MCP is still connecting waits for the settled set. */
export const MCP_SETTLE_CAP_MS = 10_000;

/** The events slice `watchMcpTools` needs. */
export interface McpToolsEvents {
	on(channel: string, handler: (data: unknown) => void): unknown;
}

/**
 * Track the parent's live MCP tool definitions for in-process children (the
 * subagent runner and the workflow runner). Subscribe at extension load; the
 * getter resolves to the current set. The parent's MCP connect runs in the
 * background, so a child spawned in the first seconds of a session waits for
 * the settled publish, capped so a hung server cannot stall spawns, instead of
 * baking in a still-connecting (possibly empty) snapshot. Empty when no MCP
 * servers are configured.
 */
export function watchMcpTools(events: McpToolsEvents, settleCapMs = MCP_SETTLE_CAP_MS): () => Promise<ToolDefinition[]> {
	let tools: ToolDefinition[] = [];
	let settled = false;
	let resolveSettled: (() => void) | undefined;
	const settledPromise = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	events.on(MCP_TOOLS_CHANNEL, (data) => {
		const payload = data as McpToolsPayload | undefined;
		tools = payload?.tools ?? [];
		if (payload?.settled) {
			settled = true;
			resolveSettled?.();
		}
	});
	return async () => {
		if (!settled) {
			await Promise.race([
				settledPromise,
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, settleCapMs);
					timer.unref?.();
				}),
			]);
		}
		return tools;
	};
}

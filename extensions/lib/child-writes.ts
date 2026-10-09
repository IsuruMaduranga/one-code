/**
 * A subagent's or workflow agent's file edits, announced to the parent session.
 *
 * An in-process child keeps its own file tracker, so a file the parent read and
 * a child then edited looks to the parent like a change "on disk" by someone
 * else, and the parent's notice said so (the user, a formatter, a command).
 * The child runners publish each successful edit or write on the parent's bus;
 * the parent's file-tracker names the child in its notice instead. The file
 * stays stale either way, so the parent still re-reads before editing it.
 */

import { resolveToolPath } from "./tool-path.ts";

export const CHILD_WROTE_CHANNEL = "one-code:child-wrote";

export interface ChildWrote {
	/** Absolute path of the file the child changed. */
	path: string;
	/** The child's name or description, for the notice; undefined when unknown. */
	agent?: string;
}

const WRITING_TOOLS = new Set(["edit", "write"]);

/**
 * Tracks a child session's tool calls and returns the changed file when one of
 * its edit or write calls ends without an error, resolved as the child's tools
 * resolved it (lib/tool-path.ts), which is how the parent's file-tracker keys it.
 */
export function childWriteWatcher(cwd: string) {
	const started = new Map<string, string>();
	return (event: { type?: string; toolName?: string; toolCallId?: string; args?: unknown; isError?: boolean }): string | undefined => {
		if (!event.toolCallId || !event.toolName || !WRITING_TOOLS.has(event.toolName)) return undefined;
		if (event.type === "tool_execution_start") {
			const args = (event.args ?? {}) as { path?: unknown; file_path?: unknown };
			const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
			if (path) started.set(event.toolCallId, resolveToolPath(path, cwd));
			return undefined;
		}
		if (event.type !== "tool_execution_end") return undefined;
		const path = started.get(event.toolCallId);
		started.delete(event.toolCallId);
		return event.isError ? undefined : path;
	};
}

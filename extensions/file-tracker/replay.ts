/**
 * Rebuild read-before-write state from a session branch (pure): which files
 * the model has read or written this conversation, so a `--resume`d session
 * does not block every edit with "has not been read in this conversation" —
 * a claim the model can see is false in its own transcript (review T9).
 *
 * The content the model saw is not in the transcript, so a replayed file is
 * observed with its CURRENT content: an edit after resume is allowed, and a
 * change made while the session was closed is not flagged. That is Claude
 * Code's behaviour too (its read state persists across resume); the stale-edit
 * guard still catches anything that changes from this point on.
 */

const READ_TOOLS = new Set(["read", "notebook_edit"]);
const WRITE_TOOLS = new Set(["edit", "write", "notebook_edit"]);

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

/** Paths (as written in the tool input) of every successful read/edit/write on the branch, in order, deduplicated. */
export function pathsReadOnBranch(entries: unknown[]): string[] {
	const calls = new Map<string, { name: string; path: string }>();
	const seen: string[] = [];
	for (const entry of entries) {
		const e = entry as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } };
		if (e?.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content as ToolCallBlock[]) {
				if (block?.type !== "toolCall" || !block.id) continue;
				const path = block.arguments?.path;
				if (typeof path === "string" && path.trim()) calls.set(block.id, { name: block.name, path });
			}
		} else if (m.role === "toolResult" && m.toolCallId && !m.isError) {
			const call = calls.get(m.toolCallId);
			if (!call) continue;
			if (!READ_TOOLS.has(call.name) && !WRITE_TOOLS.has(call.name)) continue;
			if (!seen.includes(call.path)) seen.push(call.path);
		}
	}
	return seen;
}

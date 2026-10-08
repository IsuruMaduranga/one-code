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

import { pathArgument } from "../auto-mode/paths.ts";

const READ_TOOLS = new Set(["read", "notebook_edit"]);
const WRITE_TOOLS = new Set(["edit", "write", "notebook_edit"]);

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

type BranchMessage = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; timestamp?: number };

/**
 * Every tool call on the branch that names a path (`path`, `file_path` or
 * `notebook_path`, as the gates read it) and got a successful result, in
 * result order, with the result message's time.
 */
export function* successfulPathCalls(entries: readonly unknown[]): Generator<{ name: string; path: string; timestamp: number | undefined }> {
	const calls = new Map<string, { name: string; path: string }>();
	for (const entry of entries) {
		const e = entry as { type?: string; message?: BranchMessage };
		if (e?.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content as ToolCallBlock[]) {
				if (block?.type !== "toolCall" || !block.id) continue;
				const path = pathArgument(block.arguments);
				if (path?.trim()) calls.set(block.id, { name: block.name, path });
			}
		} else if (m.role === "toolResult" && m.toolCallId && !m.isError) {
			const call = calls.get(m.toolCallId);
			if (call) yield { ...call, timestamp: m.timestamp };
		}
	}
}

const touchesFile = (name: string) => READ_TOOLS.has(name) || WRITE_TOOLS.has(name);

/** Paths (as written in the tool input) of every successful read/edit/write on the branch, in order, deduplicated. */
export function pathsReadOnBranch(entries: readonly unknown[]): string[] {
	const seen = new Set<string>();
	for (const call of successfulPathCalls(entries)) if (touchesFile(call.name)) seen.add(call.path);
	return [...seen];
}

/**
 * Each path (as written in the tool input) a successful read/edit/write on the
 * branch touched, with the time of its last such result message: the order
 * the post-compaction file restore uses after a resume, when the modification
 * times stat'ed at those reads are gone (Claude Code uses the transcript time
 * the same way).
 */
export function lastTouchesOnBranch(entries: readonly unknown[]): Map<string, number> {
	const touches = new Map<string, number>();
	for (const call of successfulPathCalls(entries)) {
		if (touchesFile(call.name) && call.timestamp !== undefined) touches.set(call.path, call.timestamp);
	}
	return touches;
}

/**
 * The paths (as written in the tool input) that a successful `read` in the
 * kept turns returned: those files are in context already, so the
 * post-compaction restore skips them.
 */
export function keptReadPaths(kept: readonly unknown[]): string[] {
	return [...successfulPathCalls(kept)].filter((call) => call.name === "read").map((call) => call.path);
}

/**
 * Every bash call on the branch with its command and the text of its result,
 * in result order: a resumed session re-checks which files those outputs
 * showed in full (`shell-reads.ts`), against the files' current content.
 */
export function* shellCallsOnBranch(entries: readonly unknown[]): Generator<{ command: string; output: string }> {
	const commands = new Map<string, string>();
	for (const entry of entries) {
		const e = entry as { type?: string; message?: BranchMessage };
		if (e?.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content as ToolCallBlock[]) {
				const command = block?.type === "toolCall" && block.name === "bash" ? block.arguments?.command : undefined;
				if (typeof command === "string" && block.id) commands.set(block.id, command);
			}
		} else if (m.role === "toolResult" && m.toolCallId) {
			const command = commands.get(m.toolCallId);
			if (command === undefined || !Array.isArray(m.content)) continue;
			const output = (m.content as { type?: string; text?: string }[])
				.map((block) => (block?.type === "text" ? (block.text ?? "") : ""))
				.join("\n");
			yield { command, output };
		}
	}
}

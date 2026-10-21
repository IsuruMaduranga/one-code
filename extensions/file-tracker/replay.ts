/**
 * Rebuild read-before-write state from a session branch (pure): which files
 * the model has read or written this conversation, so a `--resume`d session
 * does not block every edit with "has not been read in this conversation" —
 * a claim the model can see is false in its own transcript (review T9).
 *
 * The content the model saw is not in the transcript, but each read and write
 * result records what it saw (`details.oneCodeFile`, `FileObservation`): a
 * file whose disk content still matches is observed with its current
 * content, and one that changed since is stale, so an edit needs a fresh read
 * (round-2 review H1). A result from before the record existed is observed
 * with its current content, as Claude Code's persisted read state is.
 */

import { pathArgument } from "../auto-mode/paths.ts";
import { shownInFull } from "./shell-reads.ts";

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

/** What a read or write result saw of its file, recorded in its details as `oneCodeFile`. */
export interface FileObservation {
	/** Absolute, as the tool resolved it (worktree included). */
	path: string;
	size: number;
	mtimeMs: number;
	sha256: string;
}

const isObservation = (value: unknown): value is FileObservation => {
	const v = value as Partial<FileObservation> | undefined;
	return typeof v?.path === "string" && typeof v.size === "number" && typeof v.mtimeMs === "number" && typeof v.sha256 === "string";
};

/** The latest observation each file's read or write results recorded on the branch, by absolute path. */
export function observationsOnBranch(entries: readonly unknown[]): Map<string, FileObservation> {
	const out = new Map<string, FileObservation>();
	for (const entry of entries) {
		const message = (entry as { type?: string; message?: { role?: string; isError?: boolean; details?: { oneCodeFile?: unknown } } })?.message;
		if ((entry as { type?: string })?.type !== "message" || message?.role !== "toolResult" || message.isError) continue;
		const observed = message.details?.oneCodeFile;
		if (isObservation(observed)) out.set(observed.path, observed);
	}
	return out;
}

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
 * The tracked files that a bash call in the kept turns showed in full: those
 * the call certified when it ran (`readsOf`, by call id: the directory it ran
 * in decided, never today's) whose content as the tracker last saw it (`seen`)
 * is still all in its kept output. Like a kept `read`, they are in context
 * still, so they stay read; a file changed since is then stale, not unread. A
 * call needs its result in the kept turns too, and one with no record
 * certifies nothing (a miss costs one re-read).
 */
export function keptShellReadPaths(kept: readonly unknown[], readsOf: (callId: string) => readonly string[] | undefined, seen: (path: string) => string | undefined): string[] {
	const shown = new Set<string>();
	for (const { id, output } of shellCallsOnBranch(kept)) {
		for (const path of readsOf(id) ?? []) {
			if (shown.has(path)) continue;
			const content = seen(path);
			if (content !== undefined && shownInFull(output, content)) shown.add(path);
		}
	}
	return [...shown];
}

/**
 * Every bash call on the branch with its command and the text of its result,
 * in result order: a resumed session re-checks which files those outputs
 * showed in full (`shell-reads.ts`), against the files' current content.
 */
export function* shellCallsOnBranch(entries: readonly unknown[]): Generator<{ id: string; command: string; output: string }> {
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
			yield { id: m.toolCallId, command, output };
		}
	}
}

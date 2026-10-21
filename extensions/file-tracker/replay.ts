/**
 * Rebuild read-before-write state from a session branch (pure): which files
 * the model has seen this conversation, so a `--resume`d session does not
 * block every edit with "has not been read in this conversation", a claim
 * the model can see is false in its own transcript (review T9).
 *
 * The content the model saw is not in the transcript, but each read and write
 * result records what it saw (`details.oneCodeFile`, `FileObservation`) under
 * the absolute path the tool resolved. The replay keys on that path, never on
 * the call's own spelling: a worktree rewrites a relative path only in the
 * call it runs, so the transcript's `a.ts` would resolve to the main
 * checkout's twin (round-3 review M15). A post-compaction restore records the
 * same on its pending entry, and a changed-on-disk notice records the
 * versions it named. The caller compares each observation with the disk: a
 * file that still matches is read, one that changed since is stale. A result
 * that recorded nothing (a session from before the record existed) leaves its
 * file unread: the disk as it is now is never taken as what the model saw
 * (round-2 review H1).
 */

import { latestCompaction } from "../lib/compaction-boundary.ts";
import { type FileVersion, isFileVersion, readRecord } from "../lib/ledger/records.ts";
import { shownInFull } from "./shell-reads.ts";

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

type BranchMessage = { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; details?: { oneCodeFile?: unknown } };

/** What a read or write result saw of its file, recorded in its details as `oneCodeFile`: a version with its size and modification time. */
export type FileObservation = Required<FileVersion>;

const isObservation = (value: unknown): value is FileObservation => isFileVersion(value) && value.size !== undefined && value.mtimeMs !== undefined;

/**
 * Every successful tool result on the branch that recorded what it saw of a
 * file, in branch order: its position, the tool that ran (from its call, else
 * the result's own `toolName`) and the observation.
 */
function* fileResults(entries: readonly unknown[]): Generator<{ index: number; name: string | undefined; seen: FileObservation }> {
	const names = new Map<string, string>();
	for (const [index, entry] of entries.entries()) {
		const e = entry as { type?: string; message?: BranchMessage };
		if (e?.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content as ToolCallBlock[]) if (block?.type === "toolCall" && block.id) names.set(block.id, block.name);
		} else if (m.role === "toolResult" && !m.isError) {
			const seen = m.details?.oneCodeFile;
			if (isObservation(seen)) yield { index, name: (m.toolCallId ? names.get(m.toolCallId) : undefined) ?? m.toolName, seen };
		}
	}
}

/** What the branch shows the model saw of a file, and what it was told about the file since. */
export interface SeenFile {
	/** The version the model last saw, as the result or restore that showed it recorded it. */
	seen: FileObservation;
	/** Content hashes of the changed versions a notice named after that. */
	notified: Set<string>;
}

/**
 * Each file the model saw in the entries still in context (`inContextEntries`),
 * by absolute path: the last result or post-compaction restore that showed
 * it, and the changed versions a notice named since.
 *
 * In the kept turns before the latest compaction a `read` result counts, as
 * at the compaction itself: a kept edit or write does not show the whole
 * file, so it counts only for a file a kept read showed before it, where it
 * records the version the edit left (the live tracker observes the file
 * again after its own write, and the compaction keeps that). A restore counts only after the latest compaction, and there it
 * counts whether or not a request delivered it yet. A later compaction is
 * the only thing that drops a restore undelivered (lib/ledger/fold.ts), so
 * one recorded since the latest is either delivered or rides the next
 * request, and the model sees the file before it can call a tool on it; the
 * live session counts it read from the compaction on, too. A notice counts
 * wherever it lies after the file's last observation: it is delivered or
 * pending, and announcing the same version again would repeat it.
 */
export function filesSeenOnBranch(entries: readonly unknown[]): Map<string, SeenFile> {
	const compaction = latestCompaction(entries)?.index ?? -1;
	const results = new Map([...fileResults(entries)].map((result) => [result.index, result]));
	const files = new Map<string, SeenFile>();
	const see = (seen: FileObservation) => files.set(seen.path, { seen, notified: new Set() });
	entries.forEach((entry, index) => {
		const result = results.get(index);
		if (result) {
			if (index > compaction || result.name === "read" || files.has(result.seen.path)) see(result.seen);
			return;
		}
		const record = readRecord(entry as never);
		if (record?.kind !== "pending") return;
		if (index > compaction) for (const seen of record.data.observations ?? []) if (isObservation(seen)) see(seen);
		for (const told of record.data.notified ?? []) files.get(told.path)?.notified.add(told.sha256);
	});
	return files;
}

/**
 * The files (absolute, as their results recorded them) that a successful
 * `read` in the kept turns returned: those files are in context already, so
 * the post-compaction restore skips them.
 */
export function keptReadPaths(kept: readonly unknown[]): string[] {
	return [...fileResults(kept)].filter((result) => result.name === "read").map((result) => result.seen.path);
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

/**
 * Durable session state that follows the branch (design.md section 4.3): an
 * owner records each change as a `one-code:state` entry and reads the
 * branch's latest value back at a resume, `/reload`, a fork and a `/tree`
 * switch.
 *
 * Pure: no pi imports (the session API is taken structurally).
 */
import { latestCompaction } from "../compaction-boundary.ts";
import { extensionVersion } from "../package-version.ts";
import { type EntryLike, makeRecord, RECORD, stateOnBranch } from "./records.ts";

/** The slice of the extension API that appends an entry. */
export interface EntryAppender {
	appendEntry(customType: string, data?: unknown): void;
}

/** The slice of an extension context that reads the branch. */
export interface BranchReader {
	sessionManager: { getBranch(): readonly unknown[] };
}

/** Record `value` as the branch's state for `key`. */
export function recordState(pi: EntryAppender, key: string, value: unknown): void {
	pi.appendEntry(RECORD.state, makeRecord("state", extensionVersion(), { key, value }));
}

/** The branch's latest state for `key`, or undefined when none is recorded. */
export function readState(ctx: BranchReader, key: string): unknown {
	return stateOnBranch(ctx.sessionManager.getBranch() as EntryLike[], key);
}

/**
 * The latest state for `key` on `branch` since its last compaction, or
 * undefined when none is recorded after it. For state a compaction resets
 * (design.md section 4.3 fold rules): what the summary replaced is out of the
 * model's view, so what was told before it counts as untold.
 */
export function stateSinceCompaction(branch: readonly unknown[], key: string): unknown {
	return stateOnBranch(branch.slice((latestCompaction(branch)?.index ?? -1) + 1) as EntryLike[], key);
}

/** The branch's latest state for `key` as a list of strings (other items dropped), or an empty list. */
export function readStringsState(ctx: BranchReader, key: string): string[] {
	const stored = readState(ctx, key);
	return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
}

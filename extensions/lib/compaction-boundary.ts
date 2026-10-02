/**
 * The latest compaction on a session branch, and where the entries still in
 * context start. Pure: no pi imports; pi's `SessionEntry` fits the shape.
 *
 * pi builds the context after a compaction as the summary, then the kept
 * entries from `firstKeptEntryId` (which lie before the compaction entry on the
 * branch), then everything after the compaction (`buildContextEntries`). A
 * first kept entry not found before the compaction keeps nothing.
 */

type BranchEntry = { id?: string; type?: string; timestamp?: string; firstKeptEntryId?: string | null };

export interface CompactionBoundary {
	/** Index of the latest compaction entry on the branch. */
	index: number;
	/** Index of its first kept entry, or `index` when it keeps nothing. */
	keptStart: number;
	/** The compaction's time in ms: every message produced since is newer, every kept one older. */
	time: number;
}

/** The latest compaction on the branch, or undefined when there is none. */
export function latestCompaction(entries: readonly unknown[]): CompactionBoundary | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as BranchEntry | undefined;
		if (entry?.type !== "compaction") continue;
		const kept = entries.findIndex((candidate) => (candidate as BranchEntry | undefined)?.id === entry.firstKeptEntryId);
		return { index, keptStart: kept >= 0 && kept < index ? kept : index, time: Date.parse(entry.timestamp ?? "") };
	}
	return undefined;
}

/** The branch entries still in context: from the latest compaction's kept tail on, else all of them. */
export function inContextEntries<E>(entries: readonly E[]): E[] {
	return entries.slice(latestCompaction(entries)?.keptStart ?? 0);
}

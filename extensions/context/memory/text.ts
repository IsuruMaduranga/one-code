/**
 * The memory extension's words: what the model hears when a write leaves the
 * MEMORY.md index near or past its load limits, checked after each write of
 * it. The limits themselves are in lib/context/memory-content.ts; the
 * index's truncation line belongs to the instruction block that loads it
 * (instructions).
 */

/** The index's load limits, as the base enforces them. */
export interface IndexLimits {
	maxLines: number;
	maxChars: number;
}

export interface MemoryText {
	/** The reminder after a write leaves MEMORY.md within 10% of a limit. */
	indexNearLimit(limits: IndexLimits): string;
	/** Added to the result (marked an error) of a write that left MEMORY.md past a limit; the write itself succeeded. */
	indexOverLimit(limits: IndexLimits): string;
}

const kb = (chars: number) => `${Math.round(chars / 1000)}KB`;

export const memoryText: MemoryText = {
	indexNearLimit: ({ maxLines, maxChars }: IndexLimits) =>
		`MEMORY.md is approaching its load limit (only the first ${maxLines} lines or ${kb(maxChars)} are loaded each session). Shorten it now: keep one line per entry, move detail into topic files in the memory directory, and merge or drop stale entries.`,
	indexOverLimit: ({ maxLines, maxChars }: IndexLimits) =>
		`MEMORY.md is over its load limit (${maxLines} lines / ${kb(maxChars)}): everything past the limit is dropped the next time it is loaded. The write succeeded, but rewrite the index now — one line per entry, move detail into topic files, merge or drop stale entries.`,
};

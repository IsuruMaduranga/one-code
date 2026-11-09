/**
 * What the memory extension needs from a profile (types only): the words for
 * the MEMORY.md index's load limits, checked after each write of it. The
 * limits themselves stay in the base (lib/context/memory-content.ts). The index's
 * truncation line belongs to the instruction block that loads it
 * (claude-context), not to this group.
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

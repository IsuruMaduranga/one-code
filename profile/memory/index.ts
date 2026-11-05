/**
 * One Code's memory text (the profile's `text.memory`): what the model hears
 * when a write leaves the MEMORY.md index near or past its load limits.
 */

import type { IndexLimits, MemoryText } from "../../extensions/memory/text.ts";

const kb = (chars: number) => `${Math.round(chars / 1000)}KB`;

export const memory: MemoryText = {
	indexNearLimit: ({ maxLines, maxChars }: IndexLimits) =>
		`MEMORY.md is approaching its load limit (only the first ${maxLines} lines or ${kb(maxChars)} are loaded each session). Shorten it now: keep one line per entry, move detail into topic files in the memory directory, and merge or drop stale entries.`,
	indexOverLimit: ({ maxLines, maxChars }: IndexLimits) =>
		`MEMORY.md is over its load limit (${maxLines} lines / ${kb(maxChars)}): everything past the limit is dropped the next time it is loaded. The write succeeded, but rewrite the index now — one line per entry, move detail into topic files, merge or drop stale entries.`,
};

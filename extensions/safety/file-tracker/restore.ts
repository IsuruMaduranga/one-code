/**
 * The files that come back after a compaction, and how. Pure: no pi imports,
 * no I/O.
 *
 * As in Claude Code: the five files the session read, edited or wrote with
 * the newest modification time (as stat'ed at that read or write), minus the
 * files the context still shows, are read again. A file within 5,000 tokens
 * comes back as a read call and its result, a larger one as a note to read it
 * again, while the total stays within 50,000 tokens (findings §47). Each is
 * its own `<system-reminder>` block at the start of the next user message,
 * in text.ts's words.
 */

import type { FileTrackerText } from "./text.ts";

export const RESTORE_MAX_FILES = 5;
export const RESTORE_FILE_MAX_TOKENS = 5_000;
export const RESTORE_TOTAL_MAX_TOKENS = 50_000;

/**
 * The files to restore, newest first: the touched files (path to modification
 * time) minus `skip`, at most five. A file that cannot be read again is
 * dropped afterwards, not replaced, as in Claude Code.
 */
export function restoreCandidates(touched: ReadonlyMap<string, number>, skip: (path: string) => boolean): string[] {
	const candidates: string[] = [];
	for (const [path] of [...touched].sort((a, b) => b[1] - a[1])) {
		if (candidates.length === RESTORE_MAX_FILES) break;
		if (!skip(path)) candidates.push(path);
	}
	return candidates;
}

/** What reading a candidate again gave: its text as the read tool returns it, or nothing (gone, unreadable, an image). */
export type RestoredRead = { path: string; text: string | undefined };

/** One `<system-reminder>` block of a restore; `restores` names the file whose contents it puts back in context. */
export type RestoreBlock = { text: string; restores?: string };

/**
 * The reminder blocks for the reads, in order: two blocks for a file within
 * the per-file cap (the result block `restores` it), one note for a larger
 * one, nothing for a file that could not be read. A file's blocks are kept
 * only while the running total stays within the overall cap. `restored` lists
 * the files whose contents went back into context.
 */
export function restoreBlocks(reads: RestoredRead[], estimateTokens: (text: string) => number, words: FileTrackerText): { blocks: RestoreBlock[]; restored: string[] } {
	const blocks: RestoreBlock[] = [];
	const restored: string[] = [];
	let total = 0;
	for (const { path, text } of reads) {
		if (text === undefined) continue;
		const fits = estimateTokens(text) <= RESTORE_FILE_MAX_TOKENS;
		const fileBlocks: RestoreBlock[] = fits ? [{ text: words.restoredCall({ path }) }, { text: words.restoredResult({ text }), restores: path }] : [{ text: words.tooLargeToRestore({ path }) }];
		const tokens = fileBlocks.reduce((sum, block) => sum + estimateTokens(block.text), 0);
		if (total + tokens > RESTORE_TOTAL_MAX_TOKENS) continue;
		total += tokens;
		blocks.push(...fileBlocks);
		if (fits) restored.push(path);
	}
	return { blocks, restored };
}

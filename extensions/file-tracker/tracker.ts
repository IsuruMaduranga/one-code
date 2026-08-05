/**
 * File freshness tracking (pure).
 *
 * Claude Code refuses to edit a file the model hasn't read, refuses to write over
 * one it hasn't seen, rejects an edit when the file changed after the read, and
 * reports out-of-band changes with a line-numbered excerpt. Together these stop
 * the model from clobbering someone else's edit — including its own edits made
 * through bash, which no tool hook can see.
 *
 * This module holds the state machine; `index.ts` wires it to pi's events.
 */

export type FreshnessStatus = "fresh" | "unread" | "stale" | "absent";

export interface TrackedFile {
	/** Content as of the last read or write we performed. */
	content: string;
	at: number;
}

/** Keeps memory bounded on long sessions with large files. */
const MAX_TRACKED_FILES = 300;
const MAX_TRACKED_BYTES = 512 * 1024;

export class FileTracker {
	private files = new Map<string, TrackedFile>();
	/**
	 * Content we have already warned about, per path. Kept separate from `files`
	 * because telling the model a file changed must NOT make the file count as
	 * read: Claude Code reports the change *and* still requires a fresh read
	 * before editing. Storing it here suppresses repeat warnings without
	 * clearing the stale state.
	 */
	private notified = new Map<string, string>();

	/** Record what we currently believe a file contains (after a read or a write). */
	observe(path: string, content: string, at: number): void {
		this.notified.delete(path);
		if (content.length > MAX_TRACKED_BYTES) {
			// Too large to diff usefully; remember that we saw it, not its content.
			this.files.set(path, { content: "", at });
		} else {
			this.files.set(path, { content, at });
		}
		if (this.files.size > MAX_TRACKED_FILES) {
			const oldest = [...this.files.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest) this.files.delete(oldest[0]);
		}
	}

	forget(path: string): void {
		this.files.delete(path);
		this.notified.delete(path);
	}

	/** True when this exact content has already been reported for this path. */
	alreadyNotified(path: string, content: string): boolean {
		return this.notified.get(path) === content;
	}

	markNotified(path: string, content: string): void {
		this.notified.set(path, content);
	}

	has(path: string): boolean {
		return this.files.has(path);
	}

	lastSeen(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	get tracked(): string[] {
		return [...this.files.keys()];
	}

	/**
	 * `absent`  — the file does not exist (a write creates it, which is fine)
	 * `unread`  — it exists but we have never looked at it
	 * `stale`   — it changed since we last saw it
	 * `fresh`   — what we last saw matches what is on disk
	 */
	status(path: string, currentContent: string | undefined): FreshnessStatus {
		if (currentContent === undefined) return "absent";
		const known = this.files.get(path);
		if (!known) return "unread";
		// Oversized files are tracked without content; treat them as fresh rather
		// than blocking edits we cannot reason about.
		if (known.content === "" && currentContent !== "") return "fresh";
		return known.content === currentContent ? "fresh" : "stale";
	}
}

export interface ChangeExcerpt {
	firstChangedLine: number;
	text: string;
}

/**
 * Renders the changed region of a file the way Claude Code does: the *new* lines,
 * numbered, with a little context. Deliberately not a full diff — the model needs
 * to know what the file says now, not the history of how it got there.
 */
export function describeChanges(
	previous: string,
	current: string,
	options: { context?: number; maxLines?: number } = {},
): ChangeExcerpt | undefined {
	if (previous === current) return undefined;

	const contextLines = options.context ?? 2;
	const maxLines = options.maxLines ?? 40;
	const before = previous.split("\n");
	const after = current.split("\n");

	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}

	const start = Math.max(0, prefix - contextLines);
	const end = Math.min(after.length, after.length - suffix + contextLines);
	const shown = after.slice(start, end).slice(0, maxLines);

	const numbered = shown.map((line, index) => `${start + index + 1}\t${line}`).join("\n");
	const truncated = end - start > maxLines ? `\n… ${end - start - maxLines} more changed lines` : "";

	return { firstChangedLine: prefix + 1, text: `${numbered}${truncated}` };
}

export const UNREAD_REASON = (path: string, tool: string) =>
	`Read ${path} before using ${tool} on it. The file exists and has not been read in this conversation, so an edit could silently discard content you have not seen.`;

export const STALE_REASON = (path: string) =>
	`${path} has changed on disk since you last read it — someone else, a formatter, or a command may have modified it. Read it again before editing, or your change would overwrite theirs.`;

export const EXTERNAL_CHANGE_REMINDER = (path: string, excerpt: ChangeExcerpt) =>
	`${path} was modified externally (by the user, a formatter, or a command) after you last read it. The file now reads as follows around the change (line numbers shown); re-read it if you need the full contents.\n\n${excerpt.text}`;

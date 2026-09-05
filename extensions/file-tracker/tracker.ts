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

/** What a stat says about a file on disk; equal stamps mean "no need to re-read". */
export interface FileStamp {
	mtimeMs: number;
	size: number;
}

/** Keeps memory bounded on long sessions with large files. */
const MAX_TRACKED_FILES = 300;
const MAX_TRACKED_BYTES = 512 * 1024;
/** Stamps younger than this are re-read regardless (coarse-mtime filesystems, same-tick rewrites). */
export const RACY_STAMP_MS = 2000;

export class FileTracker {
	private files = new Map<string, TrackedFile>();
	/**
	 * The disk stamp of the content last compared per path — recorded when we
	 * observe a file and again each time the change scan reads it. The scan runs
	 * after every tool call, so a full read of every tracked file each time would
	 * cost up to 300 reads per call; a stat per file and a read only when the
	 * stamp moved keeps the common "nothing changed" case cheap.
	 */
	private stamps = new Map<string, FileStamp>();
	/**
	 * Content we have already warned about, per path. Kept separate from `files`
	 * because telling the model a file changed must NOT make the file count as
	 * read: Claude Code reports the change *and* still requires a fresh read
	 * before editing. Storing it here suppresses repeat warnings without
	 * clearing the stale state.
	 */
	private notified = new Map<string, string>();

	/** Record what we currently believe a file contains (after a read or a write), and its disk stamp when known. */
	observe(path: string, content: string, at: number, stamp?: FileStamp): void {
		this.notified.delete(path);
		if (content.length > MAX_TRACKED_BYTES) {
			// Too large to diff usefully; remember that we saw it, not its content.
			this.files.set(path, { content: "", at });
		} else {
			this.files.set(path, { content, at });
		}
		if (stamp) this.stamps.set(path, stamp);
		else this.stamps.delete(path);
		if (this.files.size > MAX_TRACKED_FILES) {
			const oldest = [...this.files.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest) this.forget(oldest[0]);
		}
	}

	forget(path: string): void {
		this.files.delete(path);
		this.notified.delete(path);
		this.stamps.delete(path);
	}

	/**
	 * True when the disk stamp matches the one recorded at the last read of this
	 * path: nothing to re-read. A stamp younger than `RACY_STAMP_MS` is never
	 * trusted: a same-size rewrite within the filesystem's mtime granularity of
	 * our read would leave the stamp unchanged (git's "racy" rule), so recent
	 * files take the full read until they age past the window.
	 */
	unchangedOnDisk(path: string, stamp: FileStamp, now = Date.now()): boolean {
		if (now - stamp.mtimeMs < RACY_STAMP_MS) return false;
		const known = this.stamps.get(path);
		return known !== undefined && known.mtimeMs === stamp.mtimeMs && known.size === stamp.size;
	}

	/** The change scan read the file at this stamp; the next scan skips it until the stamp moves. */
	recordStamp(path: string, stamp: FileStamp): void {
		this.stamps.set(path, stamp);
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

/**
 * Claude Code's `edited_text_file` attachment text, with two additions: the
 * cause list also names a command (our tracker sees bash writes too), and the
 * closing clause tells the model to re-read before editing — CC marks the file
 * as read when it attaches the snippet, we deliberately do not (the stale-edit
 * guard keeps firing), so without that clause the model's next edit is blocked
 * and costs a round trip. The "intentional / don't revert / don't tell the
 * user" steer is CC's: without it a model mid-edit tends to restore its own
 * version and narrate linter noise (STEERING-REVIEW-2026-09-05 M5).
 */
export const EXTERNAL_CHANGE_REMINDER = (path: string, excerpt: ChangeExcerpt) =>
	`Note: ${path} was modified, either by the user, a linter, or a command, after you last read it. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. Here are the relevant changes (shown with line numbers); re-read the file before editing it:\n${excerpt.text}`;

/**
 * What the file-tracker extension needs from a profile (types only). The
 * extension decides what happened (a refused edit, a change on disk, a file
 * put back after compaction, which of pi's file tool results to replace);
 * the profile words it. The excerpt's numbered lines (`N<TAB>line`) are a
 * base format and reach the words already rendered.
 */

/** The changed region of a file, as the base renders it (tracker.ts describeChanges). */
export interface ChangeExcerpt {
	firstChangedLine: number;
	/** The new lines, numbered, with a little context. */
	numbered: string;
	/** Changed lines past the excerpt's cap, not shown; 0 when all are shown. */
	moreLines: number;
}

/** A pi read, write or edit result the profile words in place of pi's (results.ts). */
export type FileToolOutcome =
	/** A successful write or edit; `created` for a write that made a new file. */
	| { kind: "written"; path: string; created: boolean }
	/** A read or edit of a path that does not exist; `cwd` is the session's working directory. */
	| { kind: "missing"; cwd: string }
	/** A read of a directory; `osMessage` is pi's error. */
	| { kind: "isDirectory"; path: string; osMessage: string }
	/** A read of an empty file. */
	| { kind: "empty" };

export interface FileTrackerText {
	toolResult(outcome: FileToolOutcome): string;
	/** An edit or write of an existing file the session has not read. */
	unread(p: { path: string; tool: string }): string;
	/** An edit or write of a file that changed on disk since the session read it. */
	stale(p: { path: string }): string;
	/** A file the session read changed on disk. */
	changedOnDisk(p: { path: string; excerpt: ChangeExcerpt }): string;
	/** A file the session read was changed by one of its subagents or workflow agents; `agent` its name, when known. */
	changedByAgent(p: { path: string; agent?: string; excerpt: ChangeExcerpt }): string;
	/** Changed files past the per-scan cap on detailed notices. */
	moreChanged(p: { paths: string[] }): string;
	/** A file the session read or wrote is gone. */
	deleted(p: { path: string }): string;
	/** Files that changed while the session was not running (a resume, a reload). */
	changedWhileAway(p: { paths: string[] }): string;
	/** After compaction, a file put back: the read call... */
	restoredCall(p: { path: string }): string;
	/** ...and its result, `text` as the read tool returns it. */
	restoredResult(p: { text: string }): string;
	/** After compaction, a file too large to put back. */
	tooLargeToRestore(p: { path: string }): string;
}

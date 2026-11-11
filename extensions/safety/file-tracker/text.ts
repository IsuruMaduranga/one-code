/**
 * The file-tracker extension's words: the file tool results, refusals,
 * change notices and post-compaction restore blocks, the way Claude Code
 * words them, with our tool names (`read`, `path`) and a re-read steer added
 * because a changed file is not marked as read. The extension decides what
 * happened (a refused edit, a change on disk, a file put back after
 * compaction, which of pi's file tool results to replace). The excerpt's
 * numbered lines (`N<TAB>line`) reach the words already rendered.
 */

/** The changed region of a file, as the base renders it (tracker.ts describeChanges). */
export interface ChangeExcerpt {
	firstChangedLine: number;
	/** The new lines, numbered, with a little context. */
	numbered: string;
	/** Changed lines past the excerpt's cap, not shown; 0 when all are shown. */
	moreLines: number;
}

/** A pi read, write or edit result worded here in place of pi's (results.ts). */
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

/** The success texts say the file state is current: the tracker observes the file after every successful write or edit. */
const FILE_STATE_CURRENT = " (file state is current in your context — no need to read it back)";

const excerptText = ({ numbered, moreLines }: ChangeExcerpt) => `${numbered}${moreLines > 0 ? `\n… ${moreLines} more changed lines` : ""}`;

function toolResult(outcome: FileToolOutcome): string {
	switch (outcome.kind) {
		case "written":
			return outcome.created
				? `File created successfully at: ${outcome.path}${FILE_STATE_CURRENT}`
				: `The file ${outcome.path} has been updated successfully.${FILE_STATE_CURRENT}`;
		case "missing":
			return `File does not exist. Note: your current working directory is ${outcome.cwd}.`;
		case "isDirectory":
			return `${outcome.osMessage} '${outcome.path}'`;
		case "empty":
			return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
	}
}

export const fileTrackerText: FileTrackerText = {
	toolResult,
	unread: ({ path, tool }) =>
		`Read ${path} before using ${tool} on it. The file exists and has not been read in this conversation, so an edit could silently discard content you have not seen. A shell read counts only when it printed the whole file as it is on disk (a plain \`cat\`); after a partial one (head, sed -n, a pipe, or output cut off at the size limit) or another version of it (such as \`git show HEAD:<file>\`), use the read tool.`,
	stale: ({ path }) =>
		`${path} has changed on disk since you last read it — someone else, a formatter, or a command may have modified it. Read it again before editing, or your change would overwrite theirs.`,
	/**
	 * Claude Code's `edited_text_file` attachment text, plus a closing clause
	 * telling the model to re-read before editing: Claude Code marks the file as
	 * read when it attaches the snippet, One Code deliberately does not (the
	 * stale-edit guard keeps firing), so without the clause the next edit is
	 * refused and costs a round trip. "Take it as the current state rather than
	 * reverting it" is Claude Code's: without it a model mid-edit tends to
	 * restore its own version (STEERING-REVIEW-2026-09-05 M5).
	 */
	changedOnDisk: ({ path, excerpt }) =>
		`Note: ${path} changed on disk since you last read it. That's usually deliberate, so take it as the current state rather than reverting it; if the change looks wrong, say so rather than undoing it yourself — otherwise no need to call it out. Here are the relevant changes (shown with line numbers); re-read the file before editing it:\n${excerptText(excerpt)}`,
	/** Naming "someone else, a formatter or a command" here sent the model looking for an outside cause. */
	changedByAgent: ({ path, agent, excerpt }) =>
		`Note: ${path} was changed by ${agent ? `the agent "${agent}"` : "an agent"} you started in this session since you last read it. Take it as the current state. Here are the relevant changes (shown with line numbers); re-read the file before editing it:\n${excerptText(excerpt)}`,
	moreChanged: ({ paths }) => `${paths.length} more file(s) you read earlier changed on disk since: ${paths.join(", ")}. Re-read any of them before editing it.`,
	deleted: ({ path }) => `${path} no longer exists; it was deleted or moved after you last read or wrote it.`,
	changedWhileAway: ({ paths }) => `These files changed on disk since you last read them in this conversation: ${paths.join(", ")}. Read them again before editing them.`,
	restoredCall: ({ path }) => `Called the read tool with the following input: ${JSON.stringify({ path })}`,
	restoredResult: ({ text }) => `Result of calling the read tool:\n${text}`,
	tooLargeToRestore: ({ path }) =>
		`Note: ${path} was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.`,
};

/**
 * One Code's file-tracker text (the profile's `text.fileTracker`): Claude
 * Code's file tool results, refusals, change notices and post-compaction
 * restore blocks, with One Code's tool names (`read`, `path`) and the
 * re-read steer One Code adds because it does not mark a changed file as read.
 */

import type { ChangeExcerpt, FileToolOutcome, FileTrackerText } from "../../extensions/file-tracker/text.ts";

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

export const fileTracker: FileTrackerText = {
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

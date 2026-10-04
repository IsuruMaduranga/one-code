/**
 * Claude Code's result and error texts for pi's built-in read, write and edit
 * (pure). pi's tools keep their call shapes (`path`, `edits[]`) and their own
 * behavior; only what the model reads back changes, by rewriting the first
 * text block of a result whose text is pi's exact wording. Anything else
 * (pi's truncation notes, an image, a block another hook appended) passes
 * through untouched.
 *
 * The success texts say the file state is current, which is true here: the
 * file-tracker observes the file after every successful write or edit, so the
 * next edit is not refused as unread or stale.
 */

type Block = { type: string; text?: string };

export const FILE_STATE_CURRENT = " (file state is current in your context — no need to read it back)";

/** Claude Code's missing-file error for read and edit. */
export function fileDoesNotExist(cwd: string): string {
	return `File does not exist. Note: your current working directory is ${cwd}.`;
}

/** Claude Code's empty-file read result. */
export const EMPTY_FILE_WARNING = "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";

export interface FileToolResult {
	toolName: string;
	isError: boolean;
	content: Block[];
	/** The absolute path the tool touched. */
	path: string;
	cwd: string;
	/** For a write: whether the file existed before the call (Claude Code says "updated" then, "created" otherwise). */
	existedBefore?: boolean;
	/** For a read: whether the file is empty on disk (asked only for an empty result). */
	isEmptyFile?: () => boolean;
}

/** The first block's replacement text, or undefined to leave the result as pi wrote it. */
function rewrite(result: FileToolResult, text: string): string | undefined {
	const { toolName, isError, path, cwd } = result;
	if (toolName === "write" && !isError && text.startsWith("Successfully wrote to ")) {
		return result.existedBefore
			? `The file ${path} has been updated successfully.${FILE_STATE_CURRENT}`
			: `File created successfully at: ${path}${FILE_STATE_CURRENT}`;
	}
	if (toolName === "edit" && !isError && /^Successfully replaced \d+ block\(s\) in /.test(text)) {
		return `The file ${path} has been updated successfully.${FILE_STATE_CURRENT}`;
	}
	if (toolName === "edit" && isError && /^Could not edit file: .*\. Error code: ENOENT\.$/s.test(text)) return fileDoesNotExist(cwd);
	if (toolName === "read" && isError) {
		if (/^ENOENT: no such file or directory, \w+ '/.test(text)) return fileDoesNotExist(cwd);
		if (text === "EISDIR: illegal operation on a directory, read") return `${text} '${path}'`;
	}
	if (toolName === "read" && !isError && text === "" && result.isEmptyFile?.()) return EMPTY_FILE_WARNING;
	return undefined;
}

/** The result's content with Claude Code's text in place of pi's, or undefined when nothing changes. */
export function fileToolResultContent<B extends Block>(result: FileToolResult & { content: B[] }): B[] | undefined {
	if (!Array.isArray(result.content)) return undefined;
	const [first, ...rest] = result.content;
	if (first?.type !== "text" || typeof first.text !== "string") return undefined;
	const text = rewrite(result, first.text);
	return text === undefined ? undefined : [{ ...first, text }, ...rest];
}

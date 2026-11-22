/**
 * Which of pi's built-in read, write and edit results get our words (text.ts)
 * in place of pi's (pure). pi's tools keep their call shapes (`path`,
 * `edits[]`) and their own behavior; only what the model reads back changes,
 * by rewriting the first text block of a result whose text is pi's exact
 * wording. Anything else (pi's truncation notes, an image, a block another
 * hook appended) passes through untouched.
 *
 * The file-tracker observes the file after every successful write or edit,
 * so the next edit is not refused as unread or stale (One Code's words say
 * the file state is current).
 */

import type { FileToolOutcome, FileTrackerText } from "./text.ts";

type Block = { type: string; text?: string };

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

/** What the first block says, for text.ts to word, or undefined to leave the result as pi wrote it. */
export function fileToolOutcome(result: FileToolResult, text: string): FileToolOutcome | undefined {
	const { toolName, isError, path, cwd } = result;
	if (toolName === "write" && !isError && text.startsWith("Successfully wrote to ")) return { kind: "written", path, created: !result.existedBefore };
	if (toolName === "edit" && !isError && /^Successfully replaced \d+ block\(s\) in /.test(text)) return { kind: "written", path, created: false };
	if (toolName === "edit" && isError && /^Could not edit file: .*\. Error code: ENOENT\.$/s.test(text)) return { kind: "missing", cwd };
	if (toolName === "read" && isError) {
		if (/^ENOENT: no such file or directory, \w+ '/.test(text)) return { kind: "missing", cwd };
		if (text === "EISDIR: illegal operation on a directory, read") return { kind: "isDirectory", path, osMessage: text };
	}
	if (toolName === "read" && !isError && text === "" && result.isEmptyFile?.()) return { kind: "empty" };
	return undefined;
}

/** The result's content with our text in place of pi's, or undefined when nothing changes. */
export function fileToolResultContent<B extends Block>(result: FileToolResult & { content: B[] }, words: FileTrackerText): B[] | undefined {
	const text = firstText(result.content);
	if (text === undefined) return undefined;
	const [first, ...rest] = result.content;
	const outcome = fileToolOutcome(result, text);
	return outcome === undefined ? undefined : [{ ...first, text: words.toolResult(outcome) }, ...rest];
}

/** The text of a result's first block when that block is text, the only block pi's wording lives in. */
function firstText(content: Block[] | undefined): string | undefined {
	const first = Array.isArray(content) ? content[0] : undefined;
	return first?.type === "text" && typeof first.text === "string" ? first.text : undefined;
}

/**
 * Which of the file-tracker's refusals `text` is, found by generating each
 * one for this call: `unread`, `failed` for the others, undefined for any
 * other text. For the transcript's short line only (lib/ui/result-summary-files.ts):
 * a refusal is a blocked call, whose result pi gives no details to carry it.
 */
export function refusalKind(text: string, call: { path: string; tool: string }, words: FileTrackerText): "unread" | "failed" | undefined {
	const same = (generated: string) => text === generated.trim();
	if (same(words.unread(call))) return "unread";
	if (same(words.unreadable(call)) || same(words.notRegularFile(call)) || same(words.stale({ path: call.path }))) return "failed";
	return undefined;
}

/** What a failed read, write or edit that ran records on its details for the transcript: a missing file, or another failure. */
export function executedErrorKind(result: FileToolResult): "missing" | "failed" {
	return fileToolOutcome(result, firstText(result.content) ?? "")?.kind === "missing" ? "missing" : "failed";
}

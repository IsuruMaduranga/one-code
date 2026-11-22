/**
 * The one-line results of the file and search tools (pure), in Claude Code's
 * words: `Read 2 lines` under a read, `Found 3 files` under a search, and a
 * short line for a failed file tool (`File must be read first`, `File not
 * found`, `Error editing file`). Display only: the model reads the whole
 * result; ctrl+o shows it in the transcript too.
 *
 * The read wording is in a capture of Claude Code (`Read 2 lines` for a file
 * of "hello\n", so a trailing newline counts a last, empty line); the
 * singular, the search and the error wordings come from the reconstructed
 * source, a lead rather than a capture.
 */

import { brandedId } from "../profile/brand.mjs";
import type { ShortLine } from "./tui-render.ts";

type Block = { type: string; text?: string };
interface ResultLike {
	content?: Block[];
	details?: unknown;
}

/** pi's text note for an image read; on its own (no image block) the image was omitted. */
const PI_IMAGE_NOTE = /^Read image file \[[^\]\n]+\]\n\[Image omitted: /;

/** `Read 1 line`, `Read 2 lines`: Claude Code's noun, singular for exactly one. */
export const lineNoun = (count: number): string => (count === 1 ? "line" : "lines");

/** The first text block's text, or "" when the result has none. */
function firstText(result: ResultLike): string {
	const block = result.content?.find((b) => b.type === "text" && typeof b.text === "string");
	return block?.text ?? "";
}

/**
 * What a successful pi read returned, for its summary line: an image, or the
 * number of lines it read. Counted from typed fields where pi sets them (the
 * truncation's `outputLines`) and from the arguments (`limit`) where pi
 * appends its "more lines" notice without one, never from the notice's words.
 * Undefined when pi's own view says more: an image the model cannot see, or
 * an image pi could not send, which it answers with a text notice alone and no
 * typed field (read.ts: `Read image file [<type>]` and an "[Image omitted: …]" line).
 */
export function readSummary(result: ResultLike, args: { limit?: unknown } | undefined): { kind: "image" } | { kind: "lines"; count: number } | undefined {
	const details = result.details as { truncation?: { truncated?: boolean; outputLines?: number }; imageUnsupportedByModel?: string } | undefined;
	if (result.content?.some((block) => block.type === "image")) return details?.imageUnsupportedByModel ? undefined : { kind: "image" };
	if (PI_IMAGE_NOTE.test(firstText(result))) return undefined;
	const truncation = details?.truncation;
	if (truncation?.truncated && typeof truncation.outputLines === "number") return { kind: "lines", count: truncation.outputLines };
	const text = firstText(result);
	if (text === "") return { kind: "lines", count: 0 };
	const lines = text.split("\n").length;
	// A read that stopped at `limit` with more of the file left ends in pi's
	// two-line notice; the lines read are then exactly `limit`.
	const limit = typeof args?.limit === "number" && Number.isInteger(args.limit) && args.limit >= 0 ? args.limit : undefined;
	return { kind: "lines", count: limit === undefined ? lines : Math.min(limit, lines) };
}

/** pi's search and listing tools, and what each one counts. */
export type SearchTool = "grep" | "find" | "ls";

/** pi's whole text for a search that found nothing (grep.ts, find.ts, ls.ts). */
const EMPTY_RESULT: Record<SearchTool, string> = {
	grep: "No matches found",
	find: "No files found matching pattern",
	ls: "(empty directory)",
};

/**
 * How many lines a pi search or listing returned. pi appends a bracketed
 * notice paragraph exactly when its details flag a limit, so the last
 * paragraph is dropped only then.
 */
export function searchCount(tool: SearchTool, result: ResultLike): number {
	const text = firstText(result).trim();
	if (text === "" || text === EMPTY_RESULT[tool]) return 0;
	const details = result.details as { truncation?: { truncated?: boolean }; matchLimitReached?: unknown; linesTruncated?: unknown; resultLimitReached?: unknown; entryLimitReached?: unknown } | undefined;
	const noticed = Boolean(details?.truncation?.truncated || details?.matchLimitReached || details?.linesTruncated || details?.resultLimitReached || details?.entryLimitReached);
	const cut = noticed ? text.lastIndexOf("\n\n") : -1;
	const body = cut === -1 ? text : text.slice(0, cut);
	return body.split("\n").filter((line) => line.trim() !== "").length;
}

/** `Found 3 lines`, `Found 1 file`, `Listed 4 paths`: the summary words for a search's count. */
export function searchSummaryWords(tool: SearchTool, count: number): { verb: string; noun: string } {
	const plural = count === 1 ? "" : "s";
	if (tool === "grep") return { verb: "Found", noun: `line${plural}` };
	if (tool === "find") return { verb: "Found", noun: `file${plural}` };
	return { verb: "Listed", noun: `path${plural}` };
}

/**
 * Why a file tool failed, when the harness can tell: the file-tracker refused
 * an unread file (`unread`) or another way (`failed`), or the tool ran and
 * failed on a missing file (`missing`) or otherwise (`failed`). A failure the
 * harness did not classify (a permission rule, plan mode) keeps its words.
 */
export type FileErrorKind = "unread" | "missing" | "failed";

/** The file operation a failed tool names in Claude Code's words. */
export type FileErrorOp = "read" | "edit" | "write";

/** pi's text for a call stopped by Esc (agent-loop.ts `createErrorToolResult`). */
export const PI_ABORTED_TEXT = "Operation aborted";

/** The kind the file-tracker put on an executed call's `details.fileError`, if any. */
export function fileErrorKindOf(details: unknown): FileErrorKind | undefined {
	const kind = (details as { fileError?: unknown } | undefined)?.fileError;
	return kind === "unread" || kind === "missing" || kind === "failed" ? kind : undefined;
}

/**
 * Claude Code's short line for a failed file tool: a dim "File must be read
 * first" for an edit of an unread file (the harness working as intended), a
 * red "File not found" for a missing file, and a red "Error editing file"
 * (reading, writing) for any other failure it can tell; its write names
 * every failure the same way. Undefined for an unclassified failure.
 */
export function fileErrorLine(op: FileErrorOp, kind: FileErrorKind | undefined): ShortLine | undefined {
	if (kind === undefined) return undefined;
	if (op === "edit" && kind === "unread") return { text: "File must be read first", color: "dim" };
	if (op !== "write" && kind === "missing") return { text: "File not found", color: "error" };
	return { text: op === "edit" ? "Error editing file" : op === "write" ? "Error writing file" : "Error reading file", color: "error" };
}

/**
 * Asks the file-tracker whether a file tool's error is its own refusal, by
 * the words it generates itself: a refusal is a blocked call, and pi gives a
 * blocked call's result no `details` to carry a code (agent-loop.ts
 * `prepareToolCall`). The answerer sets `kind`; nothing answers when the
 * file-tracker is off.
 */
export const FILE_ERROR_CHANNEL = brandedId("file-error-kind");
export interface FileErrorQuery {
	/** pi's tool name: `read`, `edit`, `write`. */
	toolName: string;
	/** The result's text, as the model read it. */
	text: string;
	args: unknown;
	cwd: string;
	kind?: FileErrorKind;
}

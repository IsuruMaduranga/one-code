/**
 * Markdown block starts (pure): the first-line shapes a text prefix (the
 * assistant's `●`, the user's `❯`) would turn into paragraph text.
 */

/**
 * First-line shapes a prefix would corrupt: markdown blocks that must begin
 * at the line's start. Matched against a line with its indentation removed.
 */
export const BLOCK_START = [
	/^#{1,6}\s/, // ATX heading
	/^[-*+]\s/, // unordered list item
	/^\d+[.)]\s/, // ordered list item
	/^>/, // block quote
	/^(?:```|~~~)/, // fenced code
	/^\|/, // table row
	/^(?:-{3,}|\*{3,}|_{3,})\s*$/, // horizontal rule
	/^</, // raw HTML / tag
	/^\[(?:[^\]\\]|\\.)+\]:/, // link reference definition (a destination may follow on the next line)
];

/** Four columns of indentation open an indented code block (a tab reaches the next stop of four). */
const INDENTED_CODE = /^(?: {4}| {0,3}\t)/;

/**
 * Whether `line`, as the first line of a message, opens a Markdown block:
 * one of `BLOCK_START` after up to three spaces of indentation (CommonMark
 * allows them), or an indented code block.
 */
export function opensMarkdownBlock(line: string): boolean {
	if (INDENTED_CODE.test(line)) return true;
	const unindented = line.replace(/^ {1,3}/, "");
	return BLOCK_START.some((pattern) => pattern.test(unindented));
}

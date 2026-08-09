/**
 * Assistant message marker (pure) — Claude Code prefixes each block of assistant
 * prose with a "●" bullet in the gutter. pi renders assistant text through its
 * own markdown component, and the only hook it exposes for that text is a
 * *text-level* markdown transformer (`registerMarkdownTransformer`) — there is no
 * lines-level access to paint a true gutter, the way `prompt-marker.ts` can for
 * the input editor. So the marker rides as a `● ` prefix on the message's first
 * line instead.
 *
 * A raw prefix would corrupt any message whose first line is a markdown block
 * that must start at column 0 — a heading, a list item, a block quote, a fenced
 * code block, a table row, a horizontal rule, or raw HTML. Prepending `● ` to
 * those turns them into plain paragraphs (`● ## Title`, `● - item`), losing the
 * formatting. Those first lines are therefore left untouched: a missing marker
 * is a far lesser evil than mangled output, and assistant turns here almost
 * always open with a sentence (the system prompt asks for a preamble line before
 * tools), so the guard rarely fires.
 *
 * Kept here as a pure string→string function so it is unit-testable without a
 * terminal; `index.ts` only wires it to `pi.registerMarkdownTransformer`.
 */

/** The bullet that marks the start of a block of assistant prose. */
export const ASSISTANT_MARKER = "●";

/**
 * First-line shapes a `● ` prefix would corrupt — markdown blocks that must begin
 * at column 0. Matched against the first line only; the string is assumed already
 * trimmed of leading whitespace (pi trims assistant text before rendering).
 */
const BLOCK_START = [
	/^#{1,6}\s/, // ATX heading
	/^[-*+]\s/, // unordered list item
	/^\d+[.)]\s/, // ordered list item
	/^>/, // block quote
	/^(?:```|~~~)/, // fenced code
	/^\|/, // table row
	/^(?:-{3,}|\*{3,}|_{3,})\s*$/, // horizontal rule
	/^</, // raw HTML / tag
];

/**
 * Prefix assistant `markdown` with the `● ` marker, unless its first line is a
 * markdown block the prefix would corrupt (see `BLOCK_START`). Returns the input
 * unchanged for empty text or a corrupting first line, and never throws.
 */
export function markAssistantMarkdown(markdown: string, marker: string = ASSISTANT_MARKER): string {
	if (!markdown) return markdown;
	const newline = markdown.indexOf("\n");
	const firstLine = newline === -1 ? markdown : markdown.slice(0, newline);
	if (BLOCK_START.some((pattern) => pattern.test(firstLine))) return markdown;
	return `${marker} ${markdown}`;
}

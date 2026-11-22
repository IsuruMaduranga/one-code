/**
 * Assistant message marker (pure). Claude Code prefixes each block of assistant
 * prose with a "●" bullet in the gutter. pi renders assistant text through its
 * own markdown component, and the only hook it exposes for that text is a
 * *text-level* markdown transformer (`registerMarkdownTransformer`); there is no
 * lines-level access to paint a true gutter, the way `prompt-marker.ts` can for
 * the input editor. So the marker rides as a `● ` prefix on the message's first
 * line instead.
 *
 * A raw prefix would corrupt a message whose first line opens a markdown block
 * (a heading, a list item, a block quote, a fenced code block, a table row, a
 * horizontal rule, raw HTML): `● ## Title` is a paragraph, not a heading. Such a
 * message gets the marker alone on a line above it, a blank line apart, and its
 * markdown untouched, as the user's `❯` does (lib/ui/user-message.ts); the block
 * shapes are `opensMarkdownBlock`'s (lib/ui/markdown-blocks.ts).
 *
 * Kept here as a pure string→string function so it is unit-testable without a
 * terminal; `index.ts` only wires it to `pi.registerMarkdownTransformer`.
 */

import { opensMarkdownBlock } from "../../lib/ui/markdown-blocks.ts";

/** The bullet that marks the start of a block of assistant prose. */
export const ASSISTANT_MARKER = "●";

/**
 * Prefix assistant `markdown` with the `● ` marker, or put the marker alone
 * above it when its first line opens a markdown block the prefix would
 * corrupt. Returns empty text unchanged, and never throws.
 */
export function markAssistantMarkdown(markdown: string, marker: string = ASSISTANT_MARKER): string {
	if (!markdown) return markdown;
	const newline = markdown.indexOf("\n");
	const firstLine = newline === -1 ? markdown : markdown.slice(0, newline);
	if (opensMarkdownBlock(firstLine)) return `${marker}\n\n${markdown}`;
	return `${marker} ${markdown}`;
}

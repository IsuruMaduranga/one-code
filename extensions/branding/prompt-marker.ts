/**
 * Input prompt marker (pure) — Claude Code shows a "❯" at the start of the
 * input line; pi's editor draws none. pi's editor renders as
 * `[topBorder, ...contentLines, bottomBorder]`, and each content line begins
 * with `paddingX` literal spaces (the left gutter). We overwrite exactly those
 * gutter spaces on the first content line with a marker the caller has sized to
 * `paddingX` visible columns. The visible cursor is drawn inside the text (and
 * reported separately via getCursor), so painting into the always-blank gutter
 * never shifts text or the cursor — the coupling can only ever go wrong
 * cosmetically, never break typing.
 */

/**
 * Return a copy of the editor's rendered lines with the first content line's
 * left gutter replaced by `marker`. No-op (returns the input) when there is no
 * content line yet or the first gutter is not the blank padding we expect — so
 * an unexpected render shape degrades to "no marker" rather than corruption.
 *
 * `marker` must occupy exactly `paddingX` visible columns (e.g. "› " for 2).
 */
export function applyPromptMarker(lines: string[], paddingX: number, marker: string): string[] {
	// index 0 is always the top border; the first content line is index 1.
	if (paddingX <= 0 || lines.length < 2) return lines;
	const first = lines[1];
	if (first.slice(0, paddingX) !== " ".repeat(paddingX)) return lines;
	const out = lines.slice();
	out[1] = marker + first.slice(paddingX);
	return out;
}

/**
 * pi's grep tool prints one context window per match, so with `context` set,
 * nearby matches repeat the lines their windows share (a line once as context,
 * again as context, again as the next match). Merged here (pure): each file
 * line appears once, in the order first seen, and a line that is a match in
 * any window shows as the match. Rows are `path:N: text` (match) and
 * `path-N- text` (context); two rows are the same line only when path, number
 * and text all agree, so lines of different files are never merged. Anything
 * else (pi's notices) passes through.
 */

const MATCH_ROW = /^(.+?):(\d+): (.*)$/s;
const CONTEXT_ROW = /^(.+?)-(\d+)- (.*)$/s;

export function mergeGrepWindows(text: string): string {
	const out: string[] = [];
	/** Each line's context form → its index in `out`. */
	const at = new Map<string, number>();
	for (const line of text.split("\n")) {
		// The separator that comes first decides: a row's text may itself hold
		// `:N: ` or `-N- ` (`a.ts-12- k:3: v` is a context row).
		const asMatch = MATCH_ROW.exec(line);
		const asContext = CONTEXT_ROW.exec(line);
		const match = asMatch && (!asContext || asMatch[1].length < asContext[1].length) ? asMatch : null;
		const key = match ? `${match[1]}-${match[2]}- ${match[3]}` : asContext ? line : undefined;
		if (key === undefined) {
			out.push(line);
			continue;
		}
		const index = at.get(key);
		if (index === undefined) {
			at.set(key, out.length);
			out.push(line);
		} else if (match) {
			out[index] = line;
		}
	}
	return out.join("\n");
}

/**
 * Terminal-column width for text, matching pi-tui's own measurement.
 *
 * pi-tui measures a rendered line in terminal *columns* — a CJK ideograph or
 * an emoji is two columns, a combining mark zero — and in regular TUI mode it
 * *crashes the whole app* on a line wider than the terminal ("Rendered line
 * exceeds terminal width"). Our width helpers historically counted code points
 * (`[...text].length`) or UTF-16 units (`line.length`), so a line of N wide
 * glyphs at N ≤ width was "fitted" at 2N columns and killed pi (TUI-REVIEW H1).
 *
 * This module reproduces pi-tui's `visibleWidth`/`graphemeWidth`
 * (`@earendil-works/pi-tui` `dist/utils.js`) so every helper on top of it
 * truncates by the same measure pi-tui validates against. It stays a pure,
 * zero-dependency module: the East Asian wide/fullwidth ranges below are the
 * `wideRanges`/`fullwidthRanges` tables from `get-east-asian-width` (MIT,
 * © Sindre Sorhus — pi-tui's own width dependency), embedded verbatim so the
 * 2-vs-1 decision is byte-identical to pi's without importing pi or adding a
 * package. Grapheme segmentation and the mark/emoji classification use V8's
 * built-in `Intl.Segmenter` and Unicode property regexes.
 *
 * Synced with pi-tui 0.99.2. `text-width.test.ts` compares this measure with
 * pi-tui's over every code point to U+3FFFF and over random strings with
 * escapes, so a pi bump that changes pi-tui's measure fails the suite.
 */

// --- East Asian wide/fullwidth lookup (get-east-asian-width v1.6.0, Unicode 16) ---
// Flat, sorted [start, end] inclusive pairs. `eastAsianWidth(cp)` returns 2 when
// cp is fullwidth or wide, else 1 — the only distinction pi-tui's grapheme
// width needs (ambiguous is treated as narrow, `ambiguousAsWide` off).
const FULLWIDTH_MIN = 12288;
const FULLWIDTH_MAX = 65510;
// prettier-ignore
const FULLWIDTH_RANGES = [12288, 12288, 65281, 65376, 65504, 65510];
const WIDE_MIN = 4352;
const WIDE_MAX = 262141;
// prettier-ignore
const WIDE_RANGES = [
	4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783,
	9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934,
	9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024,
	10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175,
	11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289,
	12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871,
	12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108,
	65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576,
	110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933,
	110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374,
	127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589,
	127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968,
	127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334,
	128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716,
	128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003,
	129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678,
	129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141,
];

/** Binary search over a flat, sorted array of inclusive [start, end] pairs. */
function inRange(ranges: number[], codePoint: number): boolean {
	let low = 0;
	let high = ranges.length / 2 - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const i = mid * 2;
		if (codePoint < ranges[i]) high = mid - 1;
		else if (codePoint > ranges[i + 1]) low = mid + 1;
		else return true;
	}
	return false;
}

/** 2 for East Asian fullwidth/wide code points, 1 otherwise. */
function eastAsianWidth(codePoint: number): number {
	if (codePoint >= FULLWIDTH_MIN && codePoint <= FULLWIDTH_MAX && inRange(FULLWIDTH_RANGES, codePoint)) return 2;
	if (codePoint >= WIDE_MIN && codePoint <= WIDE_MAX && inRange(WIDE_RANGES, codePoint)) return 2;
	return 1;
}

// --- Grapheme classification (mirrors pi-tui dist/utils.js) ---
// `Intl.Segmenter` is a V8 built-in; the ES2023 lib does not always type it.
const Segmenter: new (locale?: string, options?: { granularity: string }) => {
	segment(input: string): Iterable<{ segment: string }>;
} = (Intl as unknown as { Segmenter: any }).Segmenter;
const graphemeSegmenter = new Segmenter(undefined, { granularity: "grapheme" });

// Built via `new RegExp(…, "v")` so the `v` (Unicode sets) flag — needed for
// `\p{RGI_Emoji}` and the set-subtraction below, and supported at runtime on
// Node 22+/26 — is not rejected by the ES2023 type target's static flag check.
const zeroWidthRegex = new RegExp(String.raw`^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$`, "v");
const leadingNonPrintingRegex = new RegExp(String.raw`^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+`, "v");
const nonPrintingCharRegex = new RegExp(String.raw`^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$`, "v");
const markCharRegex = new RegExp(String.raw`^\p{Mark}$`, "v");
// Marks that terminals allocate cells for when attached to a base character.
const terminalSpacingMarkRegex = new RegExp(
	String.raw`^(?:[\p{Spacing_Mark}--[᜴〮〯]]|[ٟཿါာေဳ-ဵး်-ှ])+$`,
	"v",
);
const rgiEmojiRegex = new RegExp(String.raw`^\p{RGI_Emoji}$`, "v");

/** Fast heuristic to skip the expensive RGI_Emoji test for clearly-non-emoji clusters. */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0) ?? 0;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) ||
		(cp >= 0x2300 && cp <= 0x23ff) ||
		(cp >= 0x2600 && cp <= 0x27bf) ||
		(cp >= 0x2b50 && cp <= 0x2b55) ||
		segment.includes("️") ||
		segment.length > 2
	);
}

/** Terminal columns occupied by one grapheme cluster. Mirrors pi-tui's graphemeWidth. */
export function graphemeWidth(segment: string): number {
	if (segment === "\t") return 3;
	if (terminalSpacingMarkRegex.test(segment)) return [...segment].length;
	if (zeroWidthRegex.test(segment)) return 0;
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) return 2;
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) return 0;
	// Regional-indicator symbols render as full-width emoji even in isolation.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
	let width = eastAsianWidth(cp);
	let followsMark = false;
	for (const char of [...base].slice(1)) {
		if (terminalSpacingMarkRegex.test(char)) {
			width += 1;
			followsMark = false;
		} else if (markCharRegex.test(char)) {
			followsMark = true;
		} else if (!nonPrintingCharRegex.test(char)) {
			const c = char.codePointAt(0)!;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) width += eastAsianWidth(c);
			else if (c === 0x0e33 || c === 0x0eb3) width += 1; // Thai SARA AM, Lao AM
			followsMark = false;
		}
	}
	return width;
}

// --- ANSI / OSC / APC escape handling ---
// The length of the terminal control sequence starting at index `i`, or 0.
// Mirrors pi-tui's `extractAnsiCode` exactly, because pi-tui validates a line
// with it: a CSI runs to the first `m`, `G`, `K`, `H` or `J`; an OSC or APC
// runs to BEL or ST; an unterminated sequence, or any other ESC form, is not
// a sequence, so its bytes count as text. A broader rule here measured such
// text narrower than pi-tui and could emit a line pi-tui rejects. Display text
// never carries those forms once `sanitizeDisplayText` has run.
function escapeAt(s: string, i: number): number {
	if (s.charCodeAt(i) !== 0x1b) return 0;
	const next = s[i + 1];
	if (next === "[") {
		let j = i + 2;
		while (j < s.length && !CSI_END.test(s[j])) j++;
		return j < s.length ? j + 1 - i : 0;
	}
	if (next === "]" || next === "_") {
		let j = i + 2;
		while (j < s.length) {
			if (s.charCodeAt(j) === 0x07) return j + 1 - i; // BEL
			if (s.charCodeAt(j) === 0x1b && s[j + 1] === "\\") return j + 2 - i; // ST
			j++;
		}
		return 0;
	}
	return 0;
}

const CSI_END = /[mGKHJ]/;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Visible width of a string in terminal columns: ANSI/OSC/APC escapes count
 * zero, tabs count three, wide glyphs and emoji count two, combining marks
 * zero. This is the measure pi-tui validates a rendered line against.
 */
export function visibleWidth(text: string): number {
	if (text.length === 0) return 0;
	if (PRINTABLE_ASCII.test(text)) return text.length;
	// pi-tui expands tabs before segmenting, so a mark after a tab joins the
	// last space's cluster; doing the same keeps the two measures identical.
	if (text.includes("\t")) text = text.replace(/\t/g, "   ");
	let clean = "";
	for (let i = 0; i < text.length; ) {
		const esc = escapeAt(text, i);
		if (esc) {
			i += esc;
			continue;
		}
		clean += text[i];
		i++;
	}
	// A painted line is usually plain-ASCII text wrapped in colour escapes; once
	// the escapes are gone the fast path applies again, skipping the segmenter and
	// per-grapheme regexes on the common case (every coloured menu/status line).
	if (PRINTABLE_ASCII.test(clean)) return clean.length;
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(clean)) width += graphemeWidth(segment);
	return width;
}

/**
 * Longest prefix of PLAIN (escape-free) text whose visible width is ≤ `maxCols`,
 * with the width actually taken. Splits on grapheme boundaries, so a wide glyph
 * is kept whole or dropped whole — never half-included past the limit. Plain text
 * is the escape-free case of `fitPainted`, so this delegates rather than keeping
 * a second copy of the grapheme walk.
 */
export function sliceColumns(text: string, maxCols: number): { text: string; width: number } {
	return fitPainted(text, maxCols);
}

/**
 * Longest suffix of PLAIN (escape-free) text whose visible width is ≤
 * `maxCols`, cut on a grapheme boundary: the counterpart of `sliceColumns` for
 * text that keeps its tail, such as a path whose deepest folders matter most.
 */
export function tailColumns(text: string, maxCols: number): { text: string; width: number } {
	if (maxCols <= 0) return { text: "", width: 0 };
	if (PRINTABLE_ASCII.test(text)) {
		const tail = text.slice(Math.max(0, text.length - maxCols));
		return { text: tail, width: tail.length };
	}
	const graphemes = [...graphemeSegmenter.segment(text)].map((s) => s.segment);
	let width = 0;
	let start = graphemes.length;
	while (start > 0) {
		const w = graphemeWidth(graphemes[start - 1]);
		if (width + w > maxCols) break;
		width += w;
		start--;
	}
	return { text: graphemes.slice(start).join(""), width };
}

/**
 * Hard-wrap text into chunks each ≤ `columns` visible columns, on grapheme
 * boundaries. A single glyph wider than the whole budget occupies its own chunk
 * (nothing can be dropped without losing content). The shared engine behind
 * `wrapPlainText` and the subagent panel's prose wrap.
 */
export function hardWrapColumns(text: string, columns: number): string[] {
	const cols = Math.max(1, columns);
	if (text.length === 0) return [""];
	const out: string[] = [];
	let rest = text;
	// Each step consumes a fitPainted prefix and advances; `fitPainted` reports
	// whether it took the whole remainder, so no separate full-width rescan is
	// needed (that rescan made wrapping O(n²) — TUI-REVIEW /simplify).
	for (;;) {
		const { text: head } = fitPainted(rest, cols);
		const chunk = head || [...rest][0] || rest; // guarantee progress on an over-wide glyph
		if (chunk.length >= rest.length) {
			out.push(rest);
			return out;
		}
		out.push(chunk);
		rest = rest.slice(chunk.length);
	}
}

/**
 * Longest prefix of a PAINTED line (interspersed ANSI/OSC escapes) whose visible
 * width is ≤ `maxCols`. Escapes are kept verbatim and cost zero columns; visible
 * runs are cut on grapheme boundaries. Returns the prefix and its visible width;
 * the caller supplies its own reset/ellipsis.
 */
export function fitPainted(line: string, maxCols: number): { text: string; width: number } {
	if (maxCols <= 0) return { text: "", width: 0 };
	if (PRINTABLE_ASCII.test(line)) {
		const clipped = line.slice(0, maxCols);
		return { text: clipped, width: clipped.length };
	}
	let out = "";
	let width = 0;
	let i = 0;
	while (i < line.length) {
		const esc = escapeAt(line, i);
		if (esc) {
			out += line.slice(i, i + esc);
			i += esc;
			continue;
		}
		// Consume the visible run up to the next escape, segment it into graphemes.
		// An ESC that starts no sequence is text (width 0), so the run starts past it.
		let end = line.charCodeAt(i) === 0x1b ? i + 1 : i;
		while (end < line.length && line.charCodeAt(end) !== 0x1b) end++;
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, end))) {
			const w = graphemeWidth(segment);
			if (width + w > maxCols) return { text: out, width };
			out += segment;
			width += w;
		}
		i = end;
	}
	return { text: out, width };
}

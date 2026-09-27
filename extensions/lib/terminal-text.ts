/**
 * Control characters in text that reaches the terminal (pure).
 *
 * Tool results, tool arguments, notification bodies, MCP results, fetched
 * pages and the session title all carry text One Code did not write. Sent to
 * the terminal raw, an escape sequence in it acts: OSC 0 retitles the
 * terminal, OSC 52 rewrites the clipboard in kitty, WezTerm, Alacritty and
 * Windows Terminal, cursor movement rewrites the rows above, SGR conceal hides
 * text, and a carriage return overwrites the start of the row.
 *
 * `sanitizeDisplayText` applies pi's own rule for a tool result
 * (`render-utils.js getTextOutput`: `stripAnsi`, then `sanitizeBinaryOutput`,
 * then drop `\r`), and also drops C1 controls, which some terminals act on.
 * It keeps `\n` and `\t` and never touches styling One Code adds afterwards,
 * because it runs on the text before painting. `escapeControlText` shows each
 * control character as a visible `\xHH` escape instead, for consent dialogs,
 * where the user must see exactly what would run. `sanitizeTitle` is for the
 * one-line terminal title.
 *
 * Display only: the model-facing text is never passed through these.
 */

// pi's `ansiRegex` (utils/ansi.js, from chalk's ansi-regex) matches an OSC up
// to the first ST, else CSI and the related ESC forms. Its OSC branch is a lazy
// scan to the end of the text from every `ESC ]`, quadratic on many
// unterminated ones (50,000 took 1.8 s), so `stripAnsi` walks the text once
// with the same alternation and remembers where no terminator is left.
const CSI_AT = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/y;

/** The index just past the first string terminator (BEL, `ESC \`, or C1 ST) at or after `from`, else -1. */
function stringTerminatorEnd(text: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 0x07 || ch === 0x9c) return i + 1;
		if (ch === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return -1;
}

/** `text.replace(ansiRegex, "")` in linear time: the same matches, left to right. */
function stripAnsi(text: string): string {
	let out = "";
	let from = 0;
	// No string terminator exists at or after this index (a failed search holds for every later start).
	let noTerminatorFrom = Number.POSITIVE_INFINITY;
	let i = 0;
	while (i < text.length) {
		const ch = text.charCodeAt(i);
		if (ch !== 0x1b && ch !== 0x9b) {
			i++;
			continue;
		}
		if (ch === 0x1b && text.charCodeAt(i + 1) === 0x5d && i + 2 < noTerminatorFrom) {
			const end = stringTerminatorEnd(text, i + 2);
			if (end !== -1) {
				out += text.slice(from, i);
				from = i = end;
				continue;
			}
			noTerminatorFrom = i + 2;
		}
		CSI_AT.lastIndex = i;
		const match = CSI_AT.exec(text);
		if (match) {
			out += text.slice(from, i);
			from = i = i + match[0].length;
			continue;
		}
		i++;
	}
	return out + text.slice(from);
}

/** C0 controls other than tab and newline, DEL, C1 controls, and U+FFF9 to U+FFFB (interlinear annotation). */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f￹-￻]/g;
const HAS_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f￹-￻]/;

/**
 * Text safe to write to the terminal: escape sequences removed, then every
 * control character other than `\n` and `\t` (carriage returns included, as
 * pi does). Plain text comes back unchanged (same string).
 */
export function sanitizeDisplayText(text: string): string {
	if (!HAS_UNSAFE.test(text)) return text;
	return stripAnsi(text).replace(UNSAFE, "");
}

/**
 * `label` as an OSC 8 hyperlink to `url` (pi-tui's `hyperlink`). Terminals
 * without OSC 8, and tmux without its `hyperlinks` feature, show the label
 * alone, so the label must read on its own. Both parts are sanitized, so
 * neither can end the sequence early.
 */
export function terminalLink(label: string, url: string): string {
	return `\x1b]8;;${sanitizeDisplayText(url)}\x1b\\${sanitizeDisplayText(label)}\x1b]8;;\x1b\\`;
}

/**
 * Every control character other than `\n` and `\t` shown as a visible
 * `\xHH` escape (`\x1b[8m` for an SGR conceal), so nothing in the text can
 * act on the terminal or hide part of itself.
 */
export function escapeControlText(text: string): string {
	if (!HAS_UNSAFE.test(text)) return text;
	return text.replace(UNSAFE, (ch) => {
		const code = ch.charCodeAt(0);
		return code > 0xff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\x${code.toString(16).padStart(2, "0")}`;
	});
}

/** One line for the terminal title: escape sequences and every control character removed, whitespace collapsed. */
export function sanitizeTitle(text: string): string {
	return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

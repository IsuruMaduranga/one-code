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

// pi's `ansiRegex` (utils/ansi.js, from chalk's ansi-regex): OSC up to the
// first ST, then CSI and the related ESC forms.
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI = new RegExp(
	`(?:\\u001B\\][\\s\\S]*?${ST})|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]`,
	"g",
);

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
	return text.replace(ANSI, "").replace(UNSAFE, "");
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

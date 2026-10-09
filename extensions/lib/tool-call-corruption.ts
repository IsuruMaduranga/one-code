/**
 * A streamed tool call's damage. `corrupt` is certain (not one JSON value, a
 * shell command ending inside an open double quote): the call is blocked and
 * the turn stopped. `suspect` has the shape of a cut but also of a valid
 * command (an option followed by one trailing blank): the call goes back to the
 * model once, and a repeat in the same run counts as corrupt.
 */
export interface ToolCallDamage {
	kind: "corrupt" | "suspect";
	reason: string;
}

// The last word is an option followed by one blank, or a long option with an
// empty `=` value: `grep -rn "x"` and `--include="*.py"` cut at the escaped
// quote (findings §61, Morph). A bare `FOO=` is a valid assignment.
const CUT_AFTER_OPTION = /(?:^|\s)(-{1,2}[A-Za-z][\w-]*)[ \t]$|(?:^|\s)(--[A-Za-z][\w-]*=)$/;
// Heredocs and here-strings (bash `<<`, `<<<`; PowerShell `@"…"@`, `@'…'@`)
// carry quotes the scan below cannot pair, so it does not judge them.
const HERE_DOCUMENT = /<<|@["']/;

/** Inspect one tool call's raw streamed arguments before pi's tolerant parsing hides damage. */
export function toolCallCorruptionReason(toolName: string, rawArguments: string): ToolCallDamage | undefined {
	// A tool with no parameters may stream no argument text at all; pi reads it as {}.
	if (rawArguments.trim() === "") return;
	let args: unknown;
	try {
		args = JSON.parse(rawArguments);
	} catch {
		return { kind: "corrupt", reason: "The raw tool-call arguments are not exactly one JSON value." };
	}
	if (toolName !== "bash" && toolName !== "powershell" && toolName !== "monitor") return;
	if (!args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return;
	const cut = CUT_AFTER_OPTION.exec(args.command);
	if (cut) {
		return {
			kind: "suspect",
			reason: `The shell command ends with "${cut[1] ?? cut[2]}" and nothing after it, the shape of arguments cut off before a quoted string.`,
		};
	}
	const command = args.command.trimEnd();
	if (!command.endsWith('"') || HERE_DOCUMENT.test(command)) return;

	let singleQuoted = false;
	let doubleQuoted = false;
	const escape = toolName === "powershell" ? "`" : "\\";
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (singleQuoted) {
			if (char === "'") singleQuoted = false;
		} else if (char === escape) {
			i++;
		} else if (char === "'" && !doubleQuoted) {
			singleQuoted = true;
		} else if (char === '"') {
			doubleQuoted = !doubleQuoted;
		} else if (char === "#" && !doubleQuoted && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
			// A comment runs to the end of its line.
			const newline = command.indexOf("\n", i);
			if (newline === -1) break;
			i = newline;
		}
	}
	if (doubleQuoted) return { kind: "corrupt", reason: "The shell command ends with an unbalanced double quote, indicating truncated tool-call arguments." };
}

// GLM's native tool-call tags, which a broken upstream parser leaks into the JSON arguments.
const TOOL_CALL_MARKUP = /<\/arg_value>\s{0,8}<arg_key>|<\/arg_key>\s{0,8}<arg_value>|<\/tool_call>\s{0,8}<tool_call>/g;
const LONGEST_MARKUP = 40;

/** The number of markup matches that marks a streaming call as leaked. */
export const TOOL_CALL_MARKUP_LIMIT = 2;
/**
 * The same inside file content (write, edit, notebook_edit), which can quote
 * the markup legitimately (this repo's tests do); a leak there repeats without
 * end and passes it within a few thousand characters.
 */
export const CONTENT_MARKUP_LIMIT = 50;

// A string value under one of these keys is file content.
const CONTENT_KEY = /"(?:content|oldText|newText|new_source)"\s*:\s*$/;

/** Whether `index` sits in a string value under a content key: the nearest unescaped quote before it opens that value. */
function inContentValue(text: string, index: number): boolean {
	// lastIndexOf clamps a negative start to 0, so stop before it can repeat a quote at 0.
	for (let quote = index; quote > 0; ) {
		quote = text.lastIndexOf('"', quote - 1);
		if (quote < 0) break;
		let slashes = 0;
		while (text[quote - 1 - slashes] === "\\") slashes++;
		if (slashes % 2 === 0) return CONTENT_KEY.test(text.slice(Math.max(0, quote - 32), quote));
	}
	return false;
}

/**
 * Count native tool-call markup in `text` from `from` on, for a call whose
 * arguments are still streaming, apart (`contentCount`) inside file content;
 * `next` is where the following scan resumes, so each delta is scanned once.
 */
export function scanToolCallMarkup(text: string, from: number): { count: number; contentCount: number; next: number } {
	TOOL_CALL_MARKUP.lastIndex = from;
	let count = 0;
	let contentCount = 0;
	let next = from;
	for (let match = TOOL_CALL_MARKUP.exec(text); match; match = TOOL_CALL_MARKUP.exec(text)) {
		if (inContentValue(text, match.index)) contentCount++;
		else count++;
		next = TOOL_CALL_MARKUP.lastIndex;
	}
	return { count, contentCount, next: Math.max(next, text.length - LONGEST_MARKUP) };
}

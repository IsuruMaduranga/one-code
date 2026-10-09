/** Inspect one tool call's raw streamed arguments before pi's tolerant parsing hides damage. */
export function toolCallCorruptionReason(toolName: string, rawArguments: string): string | undefined {
	// A tool with no parameters may stream no argument text at all; pi reads it as {}.
	if (rawArguments.trim() === "") return;
	let args: unknown;
	try {
		args = JSON.parse(rawArguments);
	} catch {
		return "The raw tool-call arguments are not exactly one JSON value.";
	}
	if (toolName !== "bash" && toolName !== "powershell" && toolName !== "monitor") return;
	if (!args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return;
	// A cut just before an escaped quote leaves the space or `=` that preceded it.
	if (/(?:\S[ \t]|=)$/.test(args.command)) return "The shell command ends with a single space or '=', indicating arguments cut off before a quoted string.";
	const command = args.command.trimEnd();
	if (!command.endsWith('"')) return;

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
		}
	}
	if (doubleQuoted) return "The shell command ends with an unbalanced double quote, indicating truncated tool-call arguments.";
}

// GLM's native tool-call tags, which a broken upstream parser leaks into the JSON arguments.
const TOOL_CALL_MARKUP = /<\/arg_value>\s{0,8}<arg_key>|<\/arg_key>\s{0,8}<arg_value>|<\/tool_call>\s{0,8}<tool_call>/g;
const LONGEST_MARKUP = 40;

/** The number of markup matches that marks a streaming call as leaked. */
export const TOOL_CALL_MARKUP_LIMIT = 2;

/**
 * Count native tool-call markup in `text` from `from` on, for a call whose
 * arguments are still streaming; `next` is where the following scan resumes,
 * so each delta is scanned once.
 */
export function scanToolCallMarkup(text: string, from: number): { count: number; next: number } {
	TOOL_CALL_MARKUP.lastIndex = from;
	let count = 0;
	let next = from;
	for (let match = TOOL_CALL_MARKUP.exec(text); match; match = TOOL_CALL_MARKUP.exec(text)) {
		count++;
		next = TOOL_CALL_MARKUP.lastIndex;
	}
	return { count, next: Math.max(next, text.length - LONGEST_MARKUP) };
}

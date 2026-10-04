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

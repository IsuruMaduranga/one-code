/**
 * Files a shell command showed the model in full (pure apart from the bash
 * grammar, which the caller awaits).
 *
 * The auto-mode note tells the model to read files with cat, head or sed, and
 * GPT-6 models do. Before this, the edit that followed was refused as
 * "not read in this conversation" although the whole file was in the
 * transcript: 16 refused edits in one 72-run battery (2026-10-04). A file now
 * counts as read when a reader command named it and the command's output holds
 * the file's entire current content. That one check covers every way the
 * model could have seen less: a pipe into `head`, `cat -n`, a slice, an output
 * persisted or clipped for size, a write later in the same command. The
 * stale-edit guard is unchanged, since the file is observed with that content.
 */

import { parseCommand, type Token } from "../auto-mode/shell-parse.ts";

/** Commands whose file arguments may print a whole file. */
const READERS = new Set(["cat", "head", "tail", "sed"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The plain file arguments of the reader commands in `command`, as written:
 * candidates only, each still to be checked with {@link shownInFull}. Empty
 * when the command does not parse (the grammar not loaded included).
 */
export function shellReadCandidates(command: string): string[] {
	const parsed = parseCommand(command);
	if (parsed.parseFailed) return [];
	const candidates = new Set<string>();
	for (const segment of parsed.segments) {
		if (segment.substitution !== undefined) continue;
		const first = segment.tokens.findIndex((token) => !ASSIGNMENT.test(token.value));
		if (first === -1) continue;
		const [head, ...args] = segment.tokens.slice(first);
		if (!head || head.dynamic || !READERS.has(head.value.split("/").pop() ?? "")) continue;
		for (const arg of args) if (isPlainPath(arg)) candidates.add(arg.value);
	}
	return [...candidates];
}

function isPlainPath(token: Token): boolean {
	return !token.dynamic && !token.glob && token.value !== "" && !token.value.startsWith("-");
}

/**
 * Whether `output` shows the whole of `content`. An empty file is never
 * counted (nothing in the output proves the model saw it); trailing
 * whitespace is ignored because the shell tool trims it.
 */
export function shownInFull(output: string, content: string): boolean {
	const body = content.trimEnd();
	return body !== "" && output.includes(body);
}

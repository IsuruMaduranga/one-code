/**
 * Files a shell command showed the model in full (pure apart from the bash
 * grammar, which the caller awaits).
 *
 * The auto-mode note tells the model to read files with cat, head or sed, and
 * GPT-6 models do. Before this, the edit that followed was refused as
 * "not read in this conversation" although the whole file was in the
 * transcript: 16 refused edits in one 72-run battery (2026-10-04). A file now
 * counts as read when a line that runs a reader names it and the output holds
 * the file's entire current content. That one check covers every way the
 * model could have seen less: a pipe into `head`, `cat -n`, a slice, an output
 * persisted or clipped for size, a write later in the same command. The
 * stale-edit guard is unchanged, since the file is observed with that content.
 */

import { globComponentRegex } from "../auto-mode/shell-analysis.ts";
import { parseCommand, type Token } from "../auto-mode/shell-parse.ts";

/** Commands whose file arguments may print a whole file. */
const READERS = new Set(["cat", "head", "tail", "sed"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The files `command` may have printed, as written: the plain arguments of
 * its reader commands, plus every path-like word of a line that runs a reader
 * at all. Candidates only, each still to be checked with {@link shownInFull}.
 * Empty when no reader runs or the command does not parse (the grammar not
 * loaded included).
 */
export function shellReadCandidates(command: string): string[] {
	const parsed = parseCommand(command);
	if (parsed.parseFailed) return [];
	const candidates = new Set<string>();
	let reads = false;
	for (const segment of parsed.segments) {
		const first = segment.tokens.findIndex((token) => !ASSIGNMENT.test(token.value));
		if (first === -1) continue;
		const [head, ...args] = segment.tokens.slice(first);
		if (!head || head.dynamic || !READERS.has(head.value.split("/").pop() ?? "")) continue;
		reads = true;
		if (segment.substitution !== undefined) continue;
		for (const arg of args) if (isPlainPath(arg)) candidates.add(arg.value);
	}
	// A reader fed from a variable (`for f in a.py b.py; do cat "$f"; done`)
	// names its files elsewhere in the line. Every plain path-like word is a
	// candidate then: the full-content check, not the parse, decides.
	if (reads) {
		for (const word of command.match(PATH_WORD) ?? []) if (candidates.size < MAX_CANDIDATES) candidates.add(word);
		for (const word of command.match(GLOB_WORD) ?? []) if (candidates.size < MAX_CANDIDATES) candidates.add(word);
	}
	return [...candidates];
}

/**
 * The files a candidate names: itself, or for a glob in its last component
 * (`src/*.py`, a loop's word list), the matching entries of that directory,
 * listed through `readdir` (no shell). Globs in a directory component are not
 * expanded.
 */
export function expandCandidate(word: string, readdir: (dir: string) => string[]): string[] {
	if (!/[*?[]/.test(word)) return [word];
	const slash = word.lastIndexOf("/");
	const dir = slash === -1 ? "" : word.slice(0, slash);
	if (/[*?[]/.test(dir)) return [];
	const pattern = globComponentRegex(word.slice(slash + 1));
	if (!pattern) return [];
	let names: string[];
	try {
		names = readdir(dir || ".");
	} catch {
		return [];
	}
	return names.filter((name) => !name.startsWith(".") && pattern.test(name)).map((name) => (dir ? `${dir}/${name}` : name)).slice(0, MAX_CANDIDATES);
}

/** A word that could be a file path as written: no quoting, expansion or glob characters. */
const PATH_WORD = /(?<![\w$\-])[\w.@+~][\w.@+~/,-]*/g;
/** A word with a glob character, which the shell would expand (`src/*.py`). */
const GLOB_WORD = /(?<![\w$\-])[\w.@+~/,-]*[*?[][\w.@+~/,*?[\]-]*/g;
const MAX_CANDIDATES = 50;

function isPlainPath(token: Token): boolean {
	return !token.dynamic && !token.glob && token.value !== "" && !token.value.startsWith("-");
}

/**
 * Whether `output` shows the whole of `content`. Trailing whitespace is
 * ignored because the shell tool trims it. A tiny one-line file is never
 * counted: its text turns up in outputs by chance (an adversarial GPT-6 Astra
 * run matched `completed` to "(bash completed with no output)", `1` to
 * "Exit code 1", an error line, a persisted-output tag), so the match would
 * not show that the file was printed. What the guard protects still holds for
 * a larger match under another file's name: every byte of the file was in
 * front of the model, so an edit cannot discard content it has not seen.
 */
export function shownInFull(output: string, content: string): boolean {
	const body = content.trimEnd();
	if (body.length < MIN_SHOWN_CHARS && !(body.includes("\n") && body.length >= MIN_SHOWN_LINES_CHARS)) return false;
	return output.includes(body);
}

/** A one-line file shorter than this is never counted as shown. */
const MIN_SHOWN_CHARS = 40;
/** A multi-line file shorter than this is never counted as shown. */
const MIN_SHOWN_LINES_CHARS = 16;

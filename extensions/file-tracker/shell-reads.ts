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

import { isAbsolute } from "node:path";
import { toAbsoluteBash } from "../auto-mode/paths.ts";
import { globComponentRegex, isUnknownTilde, movesDirectory, resolvePayload } from "../auto-mode/shell-analysis.ts";
import { LOOPS, parseCommand, type ParseResult, scopedTracker, type Segment, type Token } from "../auto-mode/shell-parse.ts";

/** Commands whose file arguments may print a whole file. */
const READERS = new Set(["cat", "head", "tail", "sed"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word a reader may have printed, with the absolute directory the shell resolves it in. */
export interface ShellReadCandidate {
	word: string;
	dir: string;
}

/**
 * The files `command` may have printed, as written: the plain arguments of
 * its reader commands, plus every path-like word of a line that runs a reader
 * at all. Candidates only, each still to be checked with {@link shownInFull}.
 * Each comes with the directory its reader runs in, starting from `cwd` and
 * following a literal `cd` ({@link segmentDirectories}); a reader whose
 * directory cannot be known offers nothing. Empty when no reader runs or the
 * command does not parse (the grammar not loaded included).
 */
export function shellReadCandidates(command: string, cwd: string, home: string): ShellReadCandidate[] {
	const parsed = parseCommand(command);
	if (parsed.parseFailed) return [];
	const dirs = segmentDirectories(parsed, cwd, home);
	const candidates = new Map<string, ShellReadCandidate>();
	const add = (word: string, dir: string) => candidates.set(`${dir}\0${word}`, { word, dir });
	const readerDirs = new Set<string>();
	let reads = false;
	for (const [index, segment] of parsed.segments.entries()) {
		const first = segment.tokens.findIndex((token) => !ASSIGNMENT.test(token.value));
		if (first === -1) continue;
		const [head, ...args] = segment.tokens.slice(first);
		if (!head || head.dynamic || !READERS.has(head.value.split("/").pop() ?? "")) continue;
		reads = true;
		const dir = dirs[index];
		if (dir === undefined) continue;
		readerDirs.add(dir);
		if (segment.substitution !== undefined) continue;
		for (const arg of args) if (isPlainPath(arg)) add(arg.value, dir);
	}
	// A reader fed from a variable (`for f in a.py b.py; do cat "$f"; done`)
	// names its files elsewhere in the line. Every plain path-like word is a
	// candidate then, in each directory a reader ran in: the full-content
	// check, not the parse, decides.
	if (reads) {
		const words = new Set<string>();
		for (const word of [...(command.match(PATH_WORD) ?? []), ...(command.match(GLOB_WORD) ?? [])]) if (words.size < MAX_CANDIDATES) words.add(word);
		for (const dir of [...readerDirs].slice(0, MAX_READER_DIRS)) for (const word of words) add(word, dir);
	}
	return [...candidates.values()];
}

/**
 * The absolute paths `command` may have printed: its candidates
 * ({@link shellReadCandidates}) resolved as the shell resolves them, from
 * the directory each one's reader runs in, with a glob expanded through
 * `readdir` (given an absolute directory).
 */
export function shellReadPaths(command: string, cwd: string, home: string, readdir: (dir: string) => string[]): string[] {
	const paths = new Set<string>();
	for (const { word, dir } of shellReadCandidates(command, cwd, home)) {
		for (const name of expandCandidate(word, (sub) => readdir(shellPath(dir, sub, home)))) paths.add(shellPath(dir, name, home));
	}
	return [...paths];
}

/**
 * The shell's own resolution of a word, not the file tools' (`resolveToolPath`
 * strips a leading `@`, which `cat @x` keeps): `~/` and the shell's directory only.
 */
function shellPath(dir: string, word: string, home: string): string {
	return toAbsoluteBash(dir, word, home);
}

/**
 * The directory each segment runs in, or undefined where it cannot be known.
 * Only a plain `cd <literal>` (or `cd -- <literal>`) that surely ran moves
 * the commands after it in its own subshell scope (`scopedTracker`). One that
 * may not run moves only the later members of its own `&&` list
 * (`Segment.andList`), which run only once it succeeded (`cd src && cat x`
 * inside the worktree's `cd <wt> && ( … )`). Anything else that may change
 * the directory makes the commands after it unknown, never guessed: a
 * dynamic, glob, `-` or `~user` target, an option, `pushd` and `popd`, a
 * wrapper, assignment or `!` in front, a `cd` that may not run (an `if`
 * branch, after `||`) for everything outside its `&&` list, a `cd` last in a
 * pipeline (`lastpipe` runs it in the shell around), a backgrounded line,
 * `eval` and `source`, and a line that defines a function (which may replace
 * `cd`). A loop body runs more than once, so after a move in any loop every
 * command in a loop is unknown too. A miss costs one re-read; a wrong
 * directory would certify a read that never happened.
 */
function segmentDirectories(parsed: ParseResult, cwd: string, home: string): (string | undefined)[] {
	const { segments } = parsed;
	const dirs = scopedTracker<string | undefined>(cwd);
	/** Where a `cd` that may not have run moved the later members of its `&&` list, by list. */
	const listDirs = new Map<number, string | undefined>();
	const inLoop = (segment: Segment) => segment.enclosing.some((construct) => LOOPS.has(construct));
	const loopMoves = segments.some((segment) => inLoop(segment) && mayMove(segment));
	return segments.map((segment) => {
		const inList = segment.andList !== undefined && listDirs.has(segment.andList);
		const dir = loopMoves && inLoop(segment) ? undefined : inList ? listDirs.get(segment.andList!) : dirs.get(segment);
		if (!mayMove(segment)) return dir;
		const certain = !parsed.background && !parsed.definesFunction && !segment.pipelineShell && !segment.enclosing.includes("negated_command");
		const target = certain ? literalCdTarget(segment) : undefined;
		// A relative target from an unknown directory stays unknown; an absolute one re-anchors.
		const next = target === undefined ? undefined : dir === undefined && !isAbsoluteTarget(target) ? undefined : shellPath(dir ?? cwd, target, home);
		if (segment.pipelineShell) dirs.set({ scopes: segment.pipelineShell }, undefined);
		if (segment.conditional) {
			dirs.set(segment, undefined);
			if (segment.andList !== undefined) listDirs.set(segment.andList, next);
		} else {
			dirs.set(segment, next);
		}
		return dir;
	});
}

/** Whether a segment may change the shell's directory: a `cd`/`pushd`/`popd` in any spelling, or a script run in this shell. */
function mayMove(segment: Segment): boolean {
	return movesDirectory(segment) || ["eval", "source", "."].includes(resolvePayload(segment.tokens).command);
}

/** The target of `cd <word>` or `cd -- <word>` written plainly, or undefined for any other form. */
function literalCdTarget(segment: Segment): string | undefined {
	const [head, ...args] = segment.tokens;
	if (head?.value !== "cd" || head.dynamic) return undefined;
	const rest = args[0]?.value === "--" ? args.slice(1) : args;
	if (rest.length > 1) return undefined;
	const target = rest[0];
	// A bare `cd` goes home.
	if (!target) return "~";
	if (target.dynamic || target.glob || target.value === "" || target.value.startsWith("-") || isUnknownTilde(target.value)) return undefined;
	return target.value;
}

/** Whether a `cd` target lands in the same place from any directory. */
function isAbsoluteTarget(target: string): boolean {
	return isAbsolute(target) || target === "~" || target.startsWith("~/");
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

/** A word that could be a file path as written, absolute or relative: no quoting, expansion or glob characters. */
const PATH_WORD = /(?<![\w$\-/])\/?[\w.@+~][\w.@+~/,-]*/g;
/** A word with a glob character, which the shell would expand (`src/*.py`). */
const GLOB_WORD = /(?<![\w$\-])[\w.@+~/,-]*[*?[][\w.@+~/,*?[\]-]*/g;
const MAX_CANDIDATES = 50;
/** The path-like words of a line are tried in at most this many reader directories. */
const MAX_READER_DIRS = 4;

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

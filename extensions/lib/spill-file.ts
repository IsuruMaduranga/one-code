/**
 * Keep pi's foreground shell spill file readable.
 *
 * When a foreground `bash` or `powershell` run prints more than pi keeps, pi
 * writes the whole output to `<os.tmpdir()>/pi-<shell>-<16 hex>.log` and ends
 * the text with `[… Full output: <path>]`, on success and on a failure: a
 * non-zero exit is an error result from pi 0.99 on and a thrown error before
 * it, and a timeout or an abort is always thrown. `os.tmpdir()` is outside
 * every root the permission gate treats as readable, so the "full output is
 * one read away" promise held only where outside reads skip the gate. So the
 * file is moved into the session's persisted-results dir (a readable root)
 * and the path in the text is rewritten to match.
 *
 * Only a file pi produced is moved: the path must sit directly in the temp
 * dir and carry pi's name shape, so a command that prints a look-alike line
 * cannot make the harness move some other file.
 *
 * Given a bound, the output is also cut Claude Code's way instead of pi's. pi
 * keeps the last 2,000 lines or 50 KB and drops the head, so a batched
 * command lost its first commands' output. Claude Code keeps the head: the
 * whole output up to its inline cap, past it the persisted block naming the
 * file, with the first 2 KB as the preview. pi's spill file holds the whole
 * output, so the block names it and nothing is copied.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { persistedFilePreview } from "./persisted-output.ts";

const MARKER = "Full output: ";
const PI_SPILL_NAME = /^pi-[a-z]+-[0-9a-f]{16}\.log$/;
/** The note pi ends a cut output with: `\n\n[Showing lines …` or `\n\n[Showing last …`. */
const PI_NOTE = "\n\n[Showing ";
/** pi's status after the output of a run that did not exit 0. */
const PI_STATUS = /(?:^|\n\n)Command (?:exited with code -?\d+|timed out after \S+ seconds|aborted|terminated without an exit code)$/;

/** How a shell's output is cut: whole up to `inlineMax` bytes; `persist` bounds an output pi did not spill. */
export interface OutputBound {
	inlineMax: number;
	persist: (output: string) => string;
}

/** The spill path pi named at the end of `text`, when it is one pi produced in `tmp`. Pure. */
export function piSpillPath(text: string, tmp: string = tmpdir()): string | undefined {
	const at = text.lastIndexOf(MARKER);
	if (at === -1) return undefined;
	const close = text.indexOf("]", at + MARKER.length);
	if (close === -1) return undefined;
	const path = text.slice(at + MARKER.length, close);
	if (!PI_SPILL_NAME.test(basename(path))) return undefined;
	if (resolve(dirname(path)) !== resolve(tmp)) return undefined;
	return path;
}

/** Move `from` into `dir`, keeping its name; the new path, or undefined when it could not move. */
function moveInto(from: string, dir: string): string | undefined {
	const to = join(dir, basename(from));
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			renameSync(from, to);
		} catch {
			// A different filesystem: copy, then drop the original.
			copyFileSync(from, to);
			unlinkSync(from);
		}
		return to;
	} catch {
		return undefined;
	}
}

/** `text` with a moved spill file's path rewritten, or unchanged when there is none or it cannot move. */
export function relocateSpillIn(text: string, resultsDir: string, tmp: string = tmpdir()): string {
	const from = piSpillPath(text, tmp);
	if (!from) return text;
	const to = moveInto(from, resultsDir);
	return to ? text.split(from).join(to) : text;
}

/**
 * `text` with its spill file moved and pi's tail cut replaced by Claude
 * Code's head-first one. A spill file that cannot be moved, or a text not in
 * pi's shape, keeps pi's text with only the path rewritten.
 */
export function boundSpillIn(text: string, resultsDir: string, bound: OutputBound, tmp: string = tmpdir()): string {
	const status = PI_STATUS.exec(text);
	const end = status ? status.index : text.length;
	const output = text.slice(0, end);
	const from = piSpillPath(output, tmp);
	if (!from) return bound.persist(output) + text.slice(end);
	const to = moveInto(from, resultsDir);
	if (!to) return text;
	// pi's note ends the output; anything else keeps pi's text.
	if (!output.includes(PI_NOTE) || !output.endsWith(`${from}]`)) return text.split(from).join(to);
	let whole: string | undefined;
	try {
		whole = statSync(to).size <= bound.inlineMax ? readFileSync(to, "utf8") : persistedFilePreview(to);
	} catch {
		// Unreadable after the move: pi's cut, pointing at the moved file.
	}
	return whole === undefined ? text.split(from).join(to) : whole + text.slice(end);
}

type TextResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

/**
 * Run a foreground shell execute and keep its spill file readable: on a
 * returned result the text and `details.fullOutputPath` are rewritten, and a
 * thrown error is rethrown with its message rewritten. With `bound`, the
 * output is cut Claude Code's way too.
 */
export async function keepSpillReadable<R extends TextResult>(run: () => Promise<R>, resultsDir: string, bound?: OutputBound): Promise<R> {
	const rewrite = (text: string) => (bound ? boundSpillIn(text, resultsDir, bound) : relocateSpillIn(text, resultsDir));
	let result: R;
	try {
		result = await run();
	} catch (error) {
		if (error instanceof Error) {
			const message = rewrite(error.message);
			if (message !== error.message) {
				const moved = new Error(message);
				moved.stack = error.stack;
				throw moved;
			}
		}
		throw error;
	}
	const details = result.details as { fullOutputPath?: unknown } | undefined;
	const text = result.content.find((block) => block.type === "text" && typeof block.text === "string");
	if (!text?.text) return result;
	const rewritten = rewrite(text.text);
	if (rewritten === text.text) return result;
	const from = piSpillPath(text.text);
	const to = from ? join(resultsDir, basename(from)) : undefined;
	return {
		...result,
		content: result.content.map((block) => (block === text ? { ...block, text: rewritten } : block)),
		details: details && typeof details === "object" && to ? { ...details, fullOutputPath: to } : result.details,
	};
}

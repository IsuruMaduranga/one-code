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
 */

import { copyFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MARKER = "Full output: ";
const PI_SPILL_NAME = /^pi-[a-z]+-[0-9a-f]{16}\.log$/;

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

type TextResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

/**
 * Run a foreground shell execute and keep its spill file readable: on a
 * returned result the text and `details.fullOutputPath` are rewritten, and a
 * thrown error is rethrown with its message rewritten.
 */
export async function keepSpillReadable<R extends TextResult>(run: () => Promise<R>, resultsDir: string): Promise<R> {
	let result: R;
	try {
		result = await run();
	} catch (error) {
		if (error instanceof Error) {
			const message = relocateSpillIn(error.message, resultsDir);
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
	const rewritten = relocateSpillIn(text.text, resultsDir);
	if (rewritten === text.text) return result;
	const from = piSpillPath(text.text);
	const to = from ? join(resultsDir, basename(from)) : undefined;
	return {
		...result,
		content: result.content.map((block) => (block === text ? { ...block, text: rewritten } : block)),
		details: details && typeof details === "object" && to ? { ...details, fullOutputPath: to } : result.details,
	};
}

/**
 * Claude Code-style persistence for oversized tool results (pure apart from
 * the file write).
 *
 * pi's built-in tools already bound their own output — bash truncates to a
 * temp file, read/grep paginate — but an extension-registered tool returns
 * whatever it returns, and an MCP server can hand back megabytes that would
 * land verbatim in the context window. Claude Code's answer, matched here
 * byte-for-byte so the model recognises the convention: write the full result
 * to `<session-dir>/tool-results/<tool-call-id>.txt` and return a
 * `<persisted-output>` block naming the file, its size, and a short preview.
 * The model then reads or greps the file for the parts it actually needs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oneCodeStateDir } from "./paths.ts";
import { privateSessionTempDir } from "./scratchpad.ts";

/**
 * Where a session's oversized outputs are persisted — the session dir,
 * matching Claude Code's `<session-dir>/tool-results/<id>.txt`. A session-less
 * run (`--no-session`, every workflow agent, a subagent of a session-less
 * parent) has no such dir, so the session's own private temp dir serves
 * (`<tmp>/onecode-<uid>/<project-slug>/<session-id>`, 0700, beside its
 * scratchpad). Until 2026-09-27 that fallback was one shared
 * `<tmp>/one-code` with no uid or session in its name, which the gate then
 * treated as working space: every session-less run on the machine, any
 * project and any user, read the others' outputs with no prompt. When the
 * temp dir cannot be made private, `~/.onecode/tmp/<session-id>` serves. The
 * model gets the path either way. Shared by every producer that would
 * otherwise truncate: cutting text loses context, a file keeps it one `read`
 * away.
 */
export function sessionResultsDir(
	ctx: { cwd?: string; sessionManager?: { getSessionDir?: () => string | undefined; getSessionId?: () => string } } | undefined,
): string {
	let sessionId: string | undefined;
	try {
		const dir = ctx?.sessionManager?.getSessionDir?.();
		if (dir) return dir;
		sessionId = ctx?.sessionManager?.getSessionId?.();
	} catch {
		// fall through to the private temp folder
	}
	const id = (sessionId || `process-${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "_");
	const temp = privateSessionTempDir(ctx?.cwd ?? process.cwd(), id);
	if (temp) return temp;
	const fallback = join(oneCodeStateDir(), "tmp", id);
	try {
		mkdirSync(fallback, { recursive: true, mode: 0o700 });
	} catch {
		// persistIfLarge names the failed write in its own result.
	}
	return fallback;
}

/** Claude Code persists around this size; pi's bash truncation uses 50KB too. */
export const PERSIST_MAX_BYTES = 50 * 1024;
export const PREVIEW_BYTES = 2 * 1024;

function formatSize(bytes: number): string {
	return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface PersistOptions {
	/** Directory the `tool-results/` folder is created under (the session dir). */
	dir: string;
	/** File stem — the tool call id, matching Claude Code's `toolu_*.txt` naming. */
	id: string;
	maxBytes?: number;
	previewBytes?: number;
}

/**
 * Pass text through untouched while it fits; past the limit, persist it and
 * return the block the model sees instead. A failed write degrades to the
 * preview with the error named — never to the full text, which is exactly the
 * context blowout this exists to prevent.
 */
export function persistIfLarge(text: string, options: PersistOptions): string {
	const maxBytes = options.maxBytes ?? PERSIST_MAX_BYTES;
	const size = Buffer.byteLength(text, "utf-8");
	if (size <= maxBytes) return text;

	const previewBytes = options.previewBytes ?? PREVIEW_BYTES;
	// Character slice, not byte slice: close enough to the target size, and it
	// cannot split a multibyte character.
	const preview = text.slice(0, previewBytes);

	const file = join(options.dir, "tool-results", `${options.id.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
	let saved: string;
	try {
		mkdirSync(join(options.dir, "tool-results"), { recursive: true });
		writeFileSync(file, text);
		saved = `Output too large (${formatSize(size)}). Full output saved to: ${file}`;
	} catch (error) {
		saved = `Output too large (${formatSize(size)}) and could not be saved to ${file}: ${(error as Error).message}. Only this preview survives — re-run with a narrower query if more is needed.`;
	}

	return [
		"<persisted-output>",
		saved,
		"",
		`Preview (first ${Math.round(previewBytes / 1024)}KB):`,
		preview,
		"...",
		"</persisted-output>",
	].join("\n");
}

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

import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { productStateDir } from "../profile/paths.ts";
import { privateSessionTempDir } from "../core/scratchpad.ts";
import { toolResultsText } from "./tool-results-text.ts";

/**
 * Where a session's oversized outputs are persisted, and its subagents' runs:
 * the session's own folder inside the project's sessions folder,
 * `<sessions>/<project>/<session-id>/`, as Claude Code keeps
 * `~/.claude/projects/<project>/<session-id>/tool-results/` and `subagents/`.
 * Until 2026-11-24 it was the project's sessions folder itself, so every
 * session's `tool-results/` was one folder beside the transcripts. A session-less
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
export function sessionResultsDir(ctx: SessionCtx | undefined): string {
	try {
		const dir = ctx?.sessionManager?.getSessionDir?.();
		if (dir) return join(dir, safeSessionId(ctx));
	} catch {
		// fall through to the private temp folder
	}
	return sessionTempDir(ctx);
}

/**
 * The project's session folder, where every session's transcript sits: auto
 * mode's decision log (one for the project, each line naming its session) and
 * the transcripts /doctor reads. A session-less run has none, so its own
 * private folder serves, never the project.
 */
export function projectSessionsDir(ctx: SessionCtx | undefined): string {
	try {
		const dir = ctx?.sessionManager?.getSessionDir?.();
		if (dir) return dir;
	} catch {
		// the session's own folder below
	}
	return sessionTempDir(ctx);
}

/** The session's id as a folder name, or a process-scoped one when it has none. */
function safeSessionId(ctx: SessionCtx | undefined): string {
	let sessionId: string | undefined;
	try {
		sessionId = ctx?.sessionManager?.getSessionId?.();
	} catch {
		// a process-scoped name below
	}
	return (sessionId || `process-${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "_");
}

type SessionCtx = { cwd?: string; sessionManager?: { getSessionDir?: () => string | undefined; getSessionId?: () => string } };

/** The session's private temp folder (the scratchpad's parent), else a private folder in One Code's state. */
function sessionTempDir(ctx: SessionCtx | undefined): string {
	const id = safeSessionId(ctx);
	const temp = privateSessionTempDir(ctx?.cwd ?? process.cwd(), id);
	if (temp) return temp;
	const fallback = join(productStateDir(), "tmp", id);
	try {
		mkdirSync(fallback, { recursive: true, mode: 0o700 });
	} catch {
		// persistIfLarge names the failed write in its own result.
	}
	return fallback;
}

/**
 * `<session temp folder>/tasks/<taskId>.output`, where a background shell or
 * monitor spools, as Claude Code's `getTaskOutputDir()` does. The model reads
 * this file, so it must not sit beside the session transcripts: auto mode's
 * classifier takes a path under the sessions folder for a transcript store
 * (findings §103). The folder does not outlive a reboot, nor does the task.
 * Undefined when the folder cannot be made.
 */
export function taskOutputPath(ctx: SessionCtx | undefined, taskId: string): string | undefined {
	try {
		const dir = join(sessionTempDir(ctx), "tasks");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return join(dir, `${taskId}.output`);
	} catch {
		return undefined;
	}
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
	return persistIfLargeOutcome(text, options).text;
}

/**
 * `persistIfLarge` with whether the text is settled: `saved` is false only
 * when the write failed, so a caller that keeps the block (a run report built
 * once) keeps only a block whose file exists and retries the write otherwise.
 * The text is the same either way.
 */
export function persistIfLargeOutcome(text: string, options: PersistOptions): { text: string; saved: boolean } {
	const maxBytes = options.maxBytes ?? PERSIST_MAX_BYTES;
	const size = Buffer.byteLength(text, "utf-8");
	if (size <= maxBytes) return { text, saved: true };

	const previewBytes = options.previewBytes ?? PREVIEW_BYTES;
	// Character slice, not byte slice: close enough to the target size, and it
	// cannot split a multibyte character.
	const preview = text.slice(0, previewBytes);

	const file = join(options.dir, "tool-results", `${options.id.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
	try {
		mkdirSync(join(options.dir, "tool-results"), { recursive: true });
		writeFileSync(file, text);
		return { text: persistedBlock(toolResultsText.persisted({ size: formatSize(size), file }), preview, previewBytes), saved: true };
	} catch (error) {
		const saved = toolResultsText.persisted({ size: formatSize(size), file, saveError: (error as Error).message });
		return { text: persistedBlock(saved, preview, previewBytes), saved: false };
	}
}

/**
 * The block for output already whole in a file (a monitor's spool): its path,
 * its size and a preview, the same shape `persistIfLarge` returns, without
 * reading or copying the file.
 */
export function persistedFileBlock(file: string, size: number, preview: string, previewBytes: number = PREVIEW_BYTES): string {
	return persistedBlock(toolResultsText.persisted({ size: formatSize(size), file }), preview, previewBytes);
}

/** Preview an existing spool without reading or copying the whole output. */
export function persistedFilePreview(path: string): string | undefined {
	let fd: number | undefined;
	try {
		const { size } = statSync(path);
		fd = openSync(path, "r");
		const head = Buffer.alloc(Math.min(size, PREVIEW_BYTES));
		const read = readSync(fd, head, 0, head.length, 0);
		return persistedFileBlock(path, size, new StringDecoder("utf8").write(head.subarray(0, read)));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function persistedBlock(saved: string, preview: string, previewBytes: number): string {
	return [
		"<persisted-output>",
		saved,
		"",
		toolResultsText.previewHeading({ kb: Math.round(previewBytes / 1024) }),
		preview,
		"...",
		"</persisted-output>",
	].join("\n");
}

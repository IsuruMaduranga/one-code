/**
 * Telling the model when a PostToolUse hook rewrote the file it just edited.
 *
 * A "formatter" hook is the common shape of PostToolUse, and its rewrite was
 * invisible: this extension loads before `file-tracker` and AWAITS the hook, so
 * by the time the tracker observes the file the hook's version is already on
 * disk and gets recorded as the model's own write. With sequential edits the
 * model was told nothing at all (3/3 runs, zero reminders); with parallel edits
 * it was told by a race, about the wrong file. A tiny-tier model then showed
 * the user its pre-hook text from memory (WEAK-MODEL-REVIEW-2026-09-06 M1).
 *
 * Claude Code has a dedicated notice for exactly this, delivered as hook
 * context on the edit's own result. This module is the deterministic detector
 * behind ours: snapshot the target before the hooks run, compare after.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Tools whose target file a PostToolUse hook is likely to reformat. */
const FILE_TOOLS = new Set(["edit", "write", "notebook_edit"]);

/**
 * Reading the whole file twice per edit is fine for source files and wrong for
 * a large generated one; past this size the comparison falls back to the disk
 * stamp, which a rewrite moves anyway.
 */
const MAX_COMPARE_BYTES = 2 * 1024 * 1024;

/** What a file looked like at snapshot time: its content, or its stamp when too large. */
export type FileSnapshot = { kind: "content"; value: string } | { kind: "stamp"; value: string } | { kind: "absent" };

/** The absolute path a file tool is acting on, or undefined for any other tool. */
export function fileToolTarget(toolName: string, input: unknown, cwd: string): string | undefined {
	if (!FILE_TOOLS.has(toolName)) return undefined;
	const raw = (input as { path?: unknown; file_path?: unknown } | undefined)?.path ?? (input as { file_path?: unknown } | undefined)?.file_path;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export function snapshotFile(path: string): FileSnapshot {
	try {
		const stat = statSync(path);
		if (stat.size > MAX_COMPARE_BYTES) return { kind: "stamp", value: `${stat.mtimeMs}:${stat.size}` };
		return { kind: "content", value: readFileSync(path, "utf-8") };
	} catch {
		// Missing, binary, or unreadable: nothing we could compare meaningfully.
		return { kind: "absent" };
	}
}

/** True when the file differs from the snapshot. An unreadable file compares equal (nothing to claim). */
export function changedSince(path: string, before: FileSnapshot): boolean {
	if (before.kind === "absent") return false;
	const after = snapshotFile(path);
	if (after.kind === "absent") return false;
	if (after.kind !== before.kind) return false;
	return after.value !== before.value;
}

/**
 * Claude Code's wording, with our tool names: the model must know the bytes on
 * disk are no longer the bytes it wrote, without being sent into a revert (the
 * hook's change is intentional).
 */
export const FORMATTER_NOTICE = (path: string) =>
	`PostToolUse hook modified ${path} after your edit (likely a formatter). The change was intentional — do not revert it. Your next edit will not fail with a stale-file error, but if its old text targets a region the hook reformatted, read the file first, and read it before reporting the file's contents to the user.`;

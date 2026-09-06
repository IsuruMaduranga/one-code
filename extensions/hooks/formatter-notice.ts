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
import { resolve } from "node:path";
import { isWritingTool, pathArgument } from "../auto-mode/paths.ts";

/**
 * Reading the whole file twice per edit is fine for source files and wrong for
 * a large generated one; past this size the comparison falls back to the disk
 * stamp, which a rewrite moves anyway.
 */
const MAX_COMPARE_BYTES = 2 * 1024 * 1024;

/**
 * What a file looked like at snapshot time: its content, or its stamp when too
 * large. `undefined` is "nothing comparable" — missing, binary or unreadable —
 * which every caller already treats as "make no claim".
 */
export type FileSnapshot = { kind: "content"; value: string } | { kind: "stamp"; value: string };

/**
 * The absolute path a file tool is acting on, or undefined for any other tool.
 * The tool set and the `path`/`file_path` field names come from `auto-mode/paths.ts`,
 * the one place that knows them, so a new writing tool is added once.
 */
export function fileToolTarget(toolName: string, input: unknown, cwd: string): string | undefined {
	if (!isWritingTool(toolName)) return undefined;
	const raw = pathArgument(input as Record<string, unknown> | undefined);
	if (!raw?.trim()) return undefined;
	return resolve(cwd, raw);
}

export function snapshotFile(path: string): FileSnapshot | undefined {
	try {
		const stat = statSync(path);
		if (stat.size > MAX_COMPARE_BYTES) return { kind: "stamp", value: `${stat.mtimeMs}:${stat.size}` };
		return { kind: "content", value: readFileSync(path, "utf-8") };
	} catch {
		// Missing, binary, or unreadable: nothing we could compare meaningfully.
		return undefined;
	}
}

/** True when the file differs from the snapshot. An unreadable file compares equal (nothing to claim). */
export function changedSince(path: string, before: FileSnapshot | undefined): boolean {
	if (!before) return false;
	const after = snapshotFile(path);
	if (!after) return false;
	// A kind change means the file crossed the MAX_COMPARE_BYTES boundary between
	// snapshots — the size changed, so the file changed. (Comparing values across
	// kinds is meaningless: a stamp is never equal to file content.)
	if (after.kind !== before.kind) return true;
	return after.value !== before.value;
}

/**
 * Claude Code's wording, with our tool names: the model must know the bytes on
 * disk are no longer the bytes it wrote, without being sent into a revert (the
 * hook's change is intentional).
 */
export const FORMATTER_NOTICE = (path: string) =>
	`PostToolUse hook modified ${path} after your edit (likely a formatter). The change was intentional — do not revert it. Your next edit will not fail with a stale-file error, but if its old text targets a region the hook reformatted, read the file first, and read it before reporting the file's contents to the user.`;

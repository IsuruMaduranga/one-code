/**
 * The file tracker's filesystem probes: what a path is and what it holds.
 * No pi imports; the decisions on what they find are in tracker.ts.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import type { FileKind } from "./tracker.ts";

/**
 * The file's text, or undefined when it is missing or cannot be read (no
 * permission, a directory). The guard tells an unreadable regular file from
 * a missing one by `fileKind` and refuses it. Read only a regular file: a
 * read of a FIFO never ends.
 */
export function readIfPresent(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * What `path` is: absent (or not one we could stat), a regular file, a
 * directory, or something else (a device, FIFO or socket, or with
 * `followSymlinks` false a symlink).
 */
export function fileKind(path: string, followSymlinks = true): FileKind {
	try {
		const stat = followSymlinks ? statSync(path) : lstatSync(path);
		return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
	} catch {
		return "absent";
	}
}

/**
 * A resident agent's output file, `tasks/<task id>.output`, as a symbolic link
 * to the run's session file, as Claude Code keeps it: a parent that looks
 * while the agent works sees every tool call and result of the run, where a
 * spool of the reply text shows only what the agent said.
 *
 * pi rewrites a session file in place and never by rename, so the link stays
 * valid for the life of the run. The link sits in the session temp folder,
 * which the system may clear while the agent idles, so each call makes it
 * again when it is gone.
 */

import { lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Point `path` at `target`. False when the link cannot be made (Windows
 * without Developer Mode or admin rights refuses a symbolic link); the caller
 * then keeps a text spool at `path`.
 */
export function linkOutputFile(path: string, target: string): boolean {
	try {
		if (readlinkSync(path) === target) return true;
	} catch {
		// absent, or a text spool written before the session file existed
	}
	// Made beside the path and renamed over it: where a link is refused, the text spool already there stays.
	const made = `${path}.link`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		rmSync(made, { force: true });
		symlinkSync(target, made);
		renameSync(made, path);
		return true;
	} catch {
		try {
			rmSync(made, { force: true });
		} catch {
			// nothing was made (the folder itself is missing or not a folder)
		}
		return false;
	}
}

/** True when `path` is a link: a write to it would land in the session file it points at. */
export function isOutputLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

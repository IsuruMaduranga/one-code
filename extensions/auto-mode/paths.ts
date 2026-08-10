/**
 * Path resolution and containment for the shell pre-gate (pure apart from fs
 * reads).
 *
 * Two fixes over the sandbox this derives from:
 *
 * 1. **The symlink leaf is inspected** (review finding N9). The original's
 *    ENOENT fallback joined literal basenames onto the nearest resolved
 *    ancestor without ever lstat-ing the leaf, so `ln -s /outside/x link`
 *    followed by `echo hi > link` resolved to `<project>/link` — inside the
 *    project — while bash wrote through the symlink to `/outside/x`.
 * 2. **Resolution failure is reported, not swallowed.** The original returned a
 *    best-effort path on failure, so the caller could not tell a real
 *    containment pass from a guess. Here an unresolvable path is `undefined`
 *    and every caller treats that as "not provably contained".
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Tools whose calls write to a path. Lives here — the lowest shared layer both
 * the shell safety floor and the permission gate import — so the two write-gates
 * share one source of truth for "which tools write" (was duplicated).
 */
export const WRITING_TOOLS = new Set(["edit", "write", "notebook_edit"]);

export function isWritingTool(toolName: string): boolean {
	return WRITING_TOOLS.has(toolName);
}

/** Case-folded on darwin/win32, where the filesystem is case-insensitive. */
function normalize(target: string): string {
	const normalized = resolve(target).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "linux" ? normalized : normalized.toLowerCase();
}

function tryRealpath(target: string): string | undefined {
	try {
		return realpathSync.native(target);
	} catch {
		try {
			return realpathSync(target);
		} catch {
			return undefined;
		}
	}
}

/**
 * Resolve a path for containment checks, following a symlink leaf that does not
 * yet have a target. Returns undefined when nothing about the path can be
 * resolved — callers must not treat that as contained.
 */
export function resolveForContainment(target: string): string | undefined {
	const absolute = resolve(target);

	const direct = tryRealpath(absolute);
	if (direct) return normalize(direct);

	// The leaf may be a dangling symlink: realpath fails on it, but writes still
	// follow it. Read the link and resolve its target instead of assuming the
	// literal path (N9).
	try {
		const stats = lstatSync(absolute);
		if (stats.isSymbolicLink()) {
			const linkTarget = readlinkSync(absolute);
			const resolvedTarget = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(absolute), linkTarget);
			// One hop is enough: the target's own realpath covers the rest of a chain.
			return resolveForContainment(resolvedTarget) ?? normalize(resolvedTarget);
		}
	} catch {
		// Does not exist yet — fall through to ancestor resolution below.
	}

	// A path being created (`> newfile`): resolve the nearest existing ancestor
	// and re-attach the tail, so a symlinked *parent* directory is still followed.
	const tail: string[] = [];
	let cursor = absolute;
	for (;;) {
		const parent = dirname(cursor);
		if (parent === cursor) return undefined;
		tail.unshift(basename(cursor));
		const realParent = tryRealpath(parent);
		if (realParent) return normalize(join(realParent, ...tail));
		cursor = parent;
	}
}

/** True only when `target` is provably at or under `base`. */
export function isWithin(base: string, target: string): boolean {
	const normalizedBase = normalize(base);
	const normalizedTarget = normalize(target);
	return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
}

/**
 * Expand a leading `~`, then resolve relative to `cwd`. Kept separate from
 * resolveForContainment so callers can report the *original* token in messages:
 * a resolved path can embed an expanded environment-variable value, and echoing
 * that back to the model leaks the secret it was meant to protect (review
 * finding N18).
 */
export function toAbsolute(cwd: string, token: string, home: string): string {
	if (token === "~") return home;
	if (token.startsWith("~/")) return resolve(home, token.slice(2));
	if (isAbsolute(token)) return resolve(token);
	return resolve(cwd, token);
}

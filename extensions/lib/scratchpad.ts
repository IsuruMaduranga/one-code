/**
 * Session scratchpad — a designated temp-files directory.
 *
 * The shape follows Claude Code's (`<tmp>/<owner>/<project-slug>/<session-id>/scratchpad`),
 * but the owner segment carries One Code's name, not Claude Code's, so a machine
 * running both products never interleaves their scratchpads under one owner dir
 * (distribution review 2026-09-09, H2). We tell the model (via a system-prompt
 * section) to use it for everything that would otherwise land in `/tmp` or leak
 * into the project. The path is per-session, so parallel sessions on one project
 * never collide.
 *
 * Three extensions need the same path (system-prompt renders the section,
 * permissions and the workflow gate allow writes into it), and jiti isolates
 * module state — so each re-derives it through `sessionScratchpadDir`.
 */

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { findGitRoot } from "./git.ts";
import { projectSlug } from "./memory.ts";
import { tryRealpath } from "./paths.ts";

/** Pure core, testable: Claude Code's path shape under a One Code-named owner dir. */
export function scratchpadDir(
	tmpRoot: string,
	uid: number | undefined,
	projectRoot: string,
	sessionId: string,
): string {
	const owner = uid === undefined ? "onecode" : `onecode-${uid}`;
	return join(tmpRoot, owner, projectSlug(projectRoot), sessionId, "scratchpad");
}

/**
 * The temp root in its resolved spelling, so the path in the prompt, the path
 * the permission check compares, and the resolved subject all name the same
 * real location: `/tmp` through its symlink (macOS: `/private/tmp`), and on
 * Windows — which has no `/tmp`; `os.tmpdir()` is `%TEMP%`, Claude Code's own
 * choice there — `%TEMP%` through its 8.3 short names, which Windows often
 * spells it with (`C:\Users\RUNNER~1\…`, `ISURUW~1` for a long user name).
 * A write's subject arrives realpath'd to the long name, so a scratchpad dir
 * kept in the short spelling never contained anything (the runner showed it,
 * findings §22). Falls back to the spelling as given where resolution fails.
 */
function resolveTmpRoot(): string {
	return tryRealpath(process.platform === "win32" ? os.tmpdir() : "/tmp") ?? os.tmpdir();
}

/** The session's scratchpad, derived the same way by every consumer. */
export function sessionScratchpadDir(cwd: string, sessionId: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	return scratchpadDir(resolveTmpRoot(), uid, findGitRoot(cwd) ?? cwd, sessionId);
}

/** The owner-level directory of a scratchpad path (`<tmp>/onecode-<uid>`). */
function ownerDirOf(scratchpad: string): string {
	return dirname(dirname(dirname(scratchpad)));
}

/** What `ownerDirProblem` needs from an `lstat`. */
export interface OwnerDirStat {
	isSymbolicLink: boolean;
	isDirectory: boolean;
	uid: number;
	mode: number;
}

/**
 * Why the owner directory cannot hold this user's scratchpads, or undefined.
 * On a shared `/tmp` the name is predictable from the uid, so another user
 * can create it first: a symlink, a directory they own, or one anyone may
 * write lets them read, rename or replace every session's files under it
 * (the sticky bit on `/tmp` does not protect entries of their directory).
 * Pure.
 */
export function ownerDirProblem(stat: OwnerDirStat, uid: number): string | undefined {
	if (stat.isSymbolicLink) return "it is a symlink";
	if (!stat.isDirectory) return "it is not a directory";
	if (stat.uid !== uid) return `it is owned by uid ${stat.uid}`;
	if (stat.mode & 0o022) return "others may write to it";
	return undefined;
}

/**
 * Create the scratchpad private to this user, or return false. The owner
 * directory is created 0700 and must then be a real directory this user owns
 * that nobody else may write (`ownerDirProblem`); one created before this
 * check with a looser mode is tightened to 0700, so other users can neither
 * list the project paths in it nor read what the model writes. Every level
 * below is created 0700 too. Windows has no shared temp root (`%TEMP%` is per
 * user), so there it only creates the directory.
 */
export function ensurePrivateScratchpad(dir: string, uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined): boolean {
	try {
		if (uid !== undefined) {
			const owner = ownerDirOf(dir);
			mkdirSync(owner, { recursive: true, mode: 0o700 });
			const stat = lstatSync(owner);
			if (ownerDirProblem({ isSymbolicLink: stat.isSymbolicLink(), isDirectory: stat.isDirectory(), uid: stat.uid, mode: stat.mode }, uid)) return false;
			if (stat.mode & 0o077) chmodSync(owner, 0o700);
		}
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether an existing scratchpad sits under a private owner directory, with
 * no side effects: for a gate that trusts a scratchpad another extension
 * created.
 */
export function isPrivateScratchpad(dir: string, uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined): boolean {
	if (uid === undefined) return true;
	try {
		const stat = lstatSync(ownerDirOf(dir));
		return ownerDirProblem({ isSymbolicLink: stat.isSymbolicLink(), isDirectory: stat.isDirectory(), uid: stat.uid, mode: stat.mode }, uid) === undefined && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

/** The session's scratchpad, created private to this user, or undefined when it cannot be. */
export function privateSessionScratchpadDir(cwd: string, sessionId: string): string | undefined {
	const dir = sessionScratchpadDir(cwd, sessionId);
	return ensurePrivateScratchpad(dir) ? dir : undefined;
}

/**
 * A session's own private temp directory, the scratchpad's parent
 * (`<tmp>/onecode-<uid>/<project-slug>/<session-id>`), created private to
 * this user, or undefined when it cannot be.
 */
export function privateSessionTempDir(cwd: string, sessionId: string): string | undefined {
	const scratchpad = sessionScratchpadDir(cwd, sessionId);
	return ensurePrivateScratchpad(scratchpad) ? dirname(scratchpad) : undefined;
}

/** Claude Code's Scratchpad Directory prompt section, verbatim (see payload.json). */
export function scratchpadPromptSection(dir: string): string {
	return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can generally be used without permission prompts.`;
}

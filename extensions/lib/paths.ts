/**
 * Where One Code reads and writes (pure).
 *
 * The policy is "own state, borrowed config": `~/.claude` is Claude Code's
 * directory and One Code treats it as a read-only compatibility surface
 * (settings, skills, agents, plugins, CLAUDE.md); everything One Code
 * *generates* — plan files, and over time the rest of its state — lands in
 * One Code's own `~/.onecode`, so neither product's artifacts mingle with the
 * other's. See "Own state, borrowed config" in docs/decisions.md.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Claude Code's config dir — the compat surface One Code reads, never writes.
 * Honours CLAUDE_CONFIG_DIR the way Claude Code itself does.
 */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The user-scope Claude Code dir for a given `home` — `claudeConfigDir` for
 * callers that thread a `home` (tests, `~`-expansion). `CLAUDE_CONFIG_DIR`
 * still wins, exactly as Claude Code honours it; project-scope `<cwd>/.claude`
 * is never relocated by that variable, so callers keep spelling that one out.
 */
export function claudeUserDir(home: string, env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

/**
 * Claude Code's `.claude.json` (MCP servers, onboarding state): beside the
 * home dir by default, and INSIDE `CLAUDE_CONFIG_DIR` when that is set — the
 * one user-scope file that does not live under `~/.claude`.
 */
export function claudeJsonPath(home: string, env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
}

/**
 * Shell-style `~` expansion with one semantics everywhere: a bare `~` is
 * `home`, `~/x` is under it, and `~user` is left alone (no other user's home is
 * ever guessed). Anything else is returned unchanged.
 */
export function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/**
 * One Code's own state dir — everything One Code generates goes here. `home`
 * defaults to the real home; callers that already thread a `home` (the settings
 * loaders, hermetic in tests) pass it so the root stays under that home when
 * `ONECODE_STATE_DIR` is unset.
 */
export function oneCodeStateDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	return env.ONECODE_STATE_DIR || join(home, ".onecode");
}

/**
 * A path with forward slashes, in Claude Code's POSIX shape on Windows
 * (`utils/windowsPaths.ts windowsPathToPosixPath`): `C:\Users\x` becomes
 * `/c/Users/x`, a UNC `\\server\share` becomes `//server/share`, anything
 * else only flips its separators. This is the form Claude Code matches
 * permission path patterns against on Windows, so a rule written for it —
 * `Read(//c/Users/x/**)` — matches here too. Elsewhere the path is unchanged.
 */
export function toPosixPath(path: string): string {
	if (process.platform !== "win32") return path;
	if (path.startsWith("\\\\")) return path.replace(/\\/g, "/");
	const drive = /^([A-Za-z]):[/\\]/.exec(path);
	if (drive) return `/${drive[1].toLowerCase()}${path.slice(2).replace(/\\/g, "/")}`;
	return path.replace(/\\/g, "/");
}

/** Separators as `/`, whatever the platform — for display and for `/`-spelled comparisons. */
export function forwardSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Filesystems that fold case (darwin, win32): two spellings of one path compare equal. */
export function foldsCase(): boolean {
	return process.platform !== "linux";
}

/**
 * The one comparison form of a path: resolved, `/` separators, no trailing
 * slash, case-folded where the filesystem folds (darwin, win32). Every
 * containment check in the codebase compares these — the shell pre-gate's
 * `resolveForContainment`/`isWithin`, the permission matcher's session dirs,
 * the safety floor — so "under this directory" means one thing everywhere.
 */
export function comparablePath(path: string): string {
	const normalized = forwardSlashes(resolve(path)).replace(/\/+$/, "");
	return foldsCase() ? normalized.toLowerCase() : normalized;
}

/** Whether `path` is at or under `dir`, on {@link comparablePath} forms. No symlink resolution — resolve both sides first when that matters. */
export function isPathAtOrUnder(path: string, dir: string): boolean {
	const target = comparablePath(path);
	const base = comparablePath(dir);
	return target === base || target.startsWith(`${base}/`);
}

/** A `path.relative` result that stays inside its base: non-empty, no `..` hop, not another root/drive. */
export function isRelativeInside(rel: string): boolean {
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `~`-abbreviated display form of a path: the home dir itself is `~`, a path
 * under it is `~/rest` with forward slashes, anything else is returned as
 * given (`C:\Users\x\.claude` under `C:\Users\x` shows as `~/.claude`;
 * `path.relative` compares case-insensitively on Windows, like its filesystem).
 */
export function tildify(path: string, home: string): string {
	if (!home) return path;
	const rest = relative(resolve(home), resolve(path));
	if (rest === "") return "~";
	return isRelativeInside(rest) ? `~/${forwardSlashes(rest)}` : path;
}


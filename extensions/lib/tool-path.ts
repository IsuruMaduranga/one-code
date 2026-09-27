/**
 * Resolve a file tool's `path` argument exactly as pi's own `read`, `edit` and
 * `write` do (`resolveToCwd` in pi-coding-agent's `core/tools/path-utils.js`,
 * over `utils/paths.js normalizePath`), vendored because the package does not
 * export it. Anything that reasons about the file a pi tool will touch (the
 * file tracker's read-before-write and stale-edit guards, our notebook tool,
 * the worktree rewrite of relative paths) must land on the same file, or a spelling pi accepts (`~/x`, `@x`,
 * `file:///…`, a non-breaking space, Git Bash's `/c/…` on Windows) slips past
 * the guard (TOOLS-REVIEW-2026-09-26 M1). Pure: no pi imports.
 *
 * Mirrors pi 0.87.1: Unicode spaces fold to a plain space, one leading `@` is
 * dropped, on Windows a Git Bash/MSYS/Cygwin/WSL drive path becomes `C:\…`,
 * `~` and `~/` expand to the home directory (and `~\` on Windows), a
 * `file://` URL becomes its path, and a relative result resolves against
 * `cwd`.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** pi's `normalizeWindowsShellPath`: `/c/x`, `/mnt/c/x`, `/cygdrive/c/x` to `C:\x`. */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return path;
	return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

export interface ToolPathOptions {
	home?: string;
	platform?: NodeJS.Platform;
}

/**
 * `raw` as pi's file tools read it before resolving it against a cwd: the
 * steps above except the last. Callers that must tell a relative path from an
 * absolute one the way pi will (the worktree rewrite) judge this, not `raw`.
 */
export function normalizeToolPath(raw: string, options: ToolPathOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (platform === "win32") path = windowsShellPath(path);
	if (path === "~") return home;
	if (path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\"))) return join(home, path.slice(2));
	if (/^file:\/\//.test(path)) {
		// A URL this platform cannot map (`file:///x` on Windows has no drive)
		// stays as written: pi's tool then fails on it, and a guard must not throw.
		try {
			return fileURLToPath(path);
		} catch {
			return path;
		}
	}
	return path;
}

/** The absolute path a pi file tool resolves `raw` to from `cwd`. */
export function resolveToolPath(raw: string, cwd: string, options: ToolPathOptions = {}): string {
	const path = normalizeToolPath(raw, options);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

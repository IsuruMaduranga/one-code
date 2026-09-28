/**
 * Where a path a PowerShell cmdlet is given resolves, and whether the
 * pre-gate may vouch for it (pure apart from filesystem reads). Used by the
 * tree verdicts in `powershell-tree.ts`; the value is PowerShell's own
 * (quotes and escapes already resolved by its parser).
 *
 * A path is refused by shape when it is UNC (`\\server`), home-relative
 * (`~`), drive-relative (`C:foo`), provider-qualified (`HKLM:`, `Env:`,
 * `FileSystem::…`, `Microsoft.PowerShell.Core\FileSystem::…`), climbs
 * (`..`) or has a space at either end; otherwise it is resolved through symlinks and judged where it
 * lands, with a wildcard in the last component judged match by match.
 */

import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { isWithin, resolveForContainment, toAbsolute } from "../auto-mode/paths.ts";
import { isSensitivePath } from "../auto-mode/sensitive.ts";

export interface PowerShellPathOptions {
	/** The working directory the command runs in. */
	cwd: string;
	/** The user's home, for `toAbsolute`. */
	home: string;
}

/**
 * Whether a path is one this check will not vouch for by shape: UNC, home,
 * a PSDrive outside the filesystem or a provider-qualified path, one that
 * climbs, or a drive-relative one.
 */
function pathUnvouchable(value: string): boolean {
	if (!value) return false;
	if (value.startsWith("\\\\") || value.startsWith("//")) return true;
	// Provider-qualified, however the provider is spelled: `FileSystem::C:\x`
	// and `Microsoft.PowerShell.Core\FileSystem::C:\x` both name C:\x, which
	// read as a relative name would be judged inside the working directory.
	if (value.includes("::")) return true;
	if (/^[A-Za-z][A-Za-z0-9]+:/.test(value)) return true; // HKLM:, env:, cert: (a drive is one letter)
	// Drive-relative (`C:foo.txt`, no separator after the colon) means "foo.txt
	// relative to PowerShell's current directory ON C:", which need not be the
	// tool's cwd; `path.isAbsolute` does not call it absolute, so `toAbsolute`
	// would join it onto the cwd and vouch for the wrong file. Refuse by shape.
	if (/^[A-Za-z]:(?![\\/])/.test(value)) return true;
	if (value.startsWith("~")) return true;
	if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return true;
	return false;
}

/** Whether a PowerShell path holds a wildcard (`*`, `?`, `[…]`), which `-Path` expands. */
export function hasPowerShellWildcard(value: string): boolean {
	return /[*?[]/.test(value);
}

/**
 * A path with the backtick escapes `-Path` drops (`` `[ `` to `[`, ``` `` ``` to
 * `` ` ``); `-LiteralPath` keeps them, so a check that does not know which
 * parameter bound the value judges both spellings.
 */
export function powershellUnescaped(value: string): string {
	return value.replace(/`([*?[\]`])/g, "$1");
}

/**
 * A PowerShell path in this platform's separators: PowerShell on macOS and
 * Linux takes `\` as a separator too, so `sub\link` is `sub/link` there, not
 * one file named with a backslash.
 */
export function powershellSeparators(value: string): string {
	return sep === "/" ? value.replaceAll("\\", "/") : value;
}

/** An absolute path by Windows or POSIX spelling: `C:\x`, `C:/x`, `/x`, `\x`. */
function isAbsoluteSpelling(value: string): boolean {
	return /^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\");
}

/**
 * The absolute path a PowerShell path value names, or undefined when it is
 * refused by shape or spells an absolute path this platform does not call
 * absolute (`C:\x` on macOS).
 */
export function powershellPathAbsolute(value: string, opts: PowerShellPathOptions): string | undefined {
	// The value is PowerShell's own, so a space at either end is part of the
	// name (`' leading.txt'`): trimming it would judge another file. Windows
	// drops a trailing space where macOS and Linux keep it, so refuse either.
	if (!value || value !== value.trim() || pathUnvouchable(value)) return undefined;
	// Resolve only what THIS platform's path module calls absolute: on a POSIX
	// host `C:\x` is not, and `toAbsolute` would join it onto the cwd and
	// vouch for a file the shell would never touch.
	if (isAbsoluteSpelling(value) && !isAbsolute(value)) return undefined;
	return toAbsolute(opts.cwd, powershellSeparators(value), opts.home);
}

type WildcardPart = { star: true } | { star: false; matches: (ch: string) => boolean };

/**
 * A PowerShell wildcard component (`*`, `?`, `[a-c]`) as a case-insensitive
 * matcher that matches a superset of what PowerShell does, or undefined.
 * Matched without a regex over the whole name: the model writes the pattern,
 * and `*a*a*a…z` would backtrack polynomially against every directory entry
 * on the permission-gate path.
 */
function wildcardMatcher(pattern: string): ((name: string) => boolean) | undefined {
	const parts: WildcardPart[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		const close = ch === "[" ? pattern.indexOf("]", i + 1) : -1;
		if (ch === "*" || ch === "?") {
			// `?` is read as `*`: a superset of what it matches (one character, or
			// none at the end of a name on some filesystem APIs), so no match escapes.
			if (!parts.at(-1)?.star) parts.push({ star: true });
		} else if (close > i + 1) {
			let set: RegExp;
			try {
				set = new RegExp(`^[${pattern.slice(i + 1, close).replace(/[\\\]^]/g, "\\$&")}]$`, "i");
			} catch {
				return undefined;
			}
			parts.push({ star: false, matches: (c) => set.test(c) });
			i = close;
		} else {
			const lower = ch.toLowerCase();
			parts.push({ star: false, matches: (c) => c.toLowerCase() === lower });
		}
	}
	// Greedy match that backtracks only to the last `*`: O(name × pattern).
	return (name) => {
		let p = 0;
		let t = 0;
		let starAt = -1;
		let resumeAt = 0;
		while (t < name.length) {
			const part = parts[p];
			if (part && !part.star && part.matches(name[t])) {
				p++;
				t++;
			} else if (part?.star) {
				starAt = p++;
				resumeAt = t;
			} else if (starAt >= 0) {
				p = starAt + 1;
				t = ++resumeAt;
			} else return false;
		}
		while (parts[p]?.star) p++;
		return p === parts.length;
	};
}

/**
 * The paths a wildcard in the last component names, or undefined when they
 * cannot be enumerated (a wildcard in a directory component, an unreadable
 * or huge directory). Matched case-insensitively and with hidden entries, a
 * superset of what PowerShell reads, so every match that could be read is judged.
 */
function wildcardTargets(absolute: string): string[] | undefined {
	const dir = dirname(absolute);
	const matches = wildcardMatcher(basename(absolute));
	if (hasPowerShellWildcard(dir) || !matches) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [dir];
	}
	if (entries.length > 2_000) return undefined;
	return [dir, ...entries.filter((entry) => matches(entry)).map((entry) => join(dir, entry))];
}

/**
 * Why a path a read cmdlet is given must not be vouched for, or undefined.
 * It is refused by shape when unvouchable, then resolved through
 * `resolveForContainment`, relative paths included: an in-project `notes.txt`
 * can be a symlink out of it (AUTO-MODE-SECURITY-REVIEW-2026-09-24 M4). A
 * wildcard leaf is judged match by match. Every target must lie inside one
 * of `roots` (realpath-resolved) and resolve to no credential path.
 */
export function powershellPathProblem(value: string, opts: PowerShellPathOptions, roots: string[]): string | undefined {
	const outside = "a path outside the working directory";
	if (!value) return undefined;
	if (isSensitivePath(value.trim())) return "a credential or secret path";
	const absolute = powershellPathAbsolute(value, opts);
	if (absolute === undefined) return outside;
	// The value's own wildcard, not one in the working directory's name. The
	// literal path is judged too: `-LiteralPath 'n[1].txt'` reads the file of
	// that name, which a bracket set does not match, and so does
	// `-Path 'n`[1`].txt'` once PowerShell drops the escaping backticks.
	const matches = hasPowerShellWildcard(value) ? wildcardTargets(absolute) : [];
	if (matches === undefined) return outside;
	const targets = [...new Set([absolute, powershellUnescaped(absolute), ...matches])];
	for (const target of targets) {
		const resolved = resolveForContainment(target);
		if (resolved === undefined || !roots.some((root) => isWithin(root, resolved))) return outside;
		if (isSensitivePath(resolved)) return "a credential or secret path";
	}
	return undefined;
}

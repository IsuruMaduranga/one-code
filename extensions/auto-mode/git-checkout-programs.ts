/**
 * Whether a checkout's own git configuration makes a read-only git command run
 * a program (pure apart from fs reads).
 *
 * The pre-gate fast-paths `git status`, `diff`, `log` and the other read-only
 * subcommands by their options (read-only-options.ts). git honours the
 * repository's `.git/config`, and some keys there name a program that those
 * reads run: `core.fsmonitor` on every index read, a `filter.<driver>.clean`
 * when `status` re-hashes a file, `diff.external` and the diff and textconv
 * drivers on `diff`/`log -p`/`show`, `gpg.program` on `log --show-signature`
 * or a `%G?` format, a pager. `status` also rewrites the index opportunistically,
 * which runs a `post-index-change` hook. A directory whose `.git` came from an
 * archive, a synced folder or a copied tree can carry any of these, so a git
 * read there is not provably read-only and goes to the classifier (PR #8
 * review; SECURITY-REVIEW-2026-09-23's folder-trust residual).
 *
 * Only repository-scoped files are read: the checkout's `config`, its
 * `config.worktree`, every submodule's config, and the hooks
 * directories (`core.hooksPath` included). The user's own global and system
 * configuration is theirs, and git-lfs's standard filter commands pass. The
 * scan is textual and wide on purpose: an unneeded escalation costs one
 * classifier call, a missed key would be code execution behind a "safe", so
 * anything it cannot read counts as a program too.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findGitRoot, gitdirFileTarget } from "../lib/git.ts";
import { expandTilde } from "../lib/paths.ts";

const BOOLEAN = /^(true|false|yes|no|on|off|1|0)?$/i;

/** git-lfs's own filter commands (`git lfs install`), resolved on the user's PATH. */
const LFS_FILTERS = new Set(["git-lfs clean -- %f", "git-lfs smudge -- %f", "git-lfs filter-process"]);

/** Keys whose value git runs during a read, by section (subsections included). */
const PROGRAM_KEYS: Record<string, (key: string, value: string | undefined) => boolean> = {
	// `core.fsmonitor=true` is git's own daemon; any other value is a hook command.
	core: (key, value) => (key === "fsmonitor" && !BOOLEAN.test(value ?? "")) || key === "pager",
	diff: (key) => key === "external" || key === "command" || key === "textconv",
	filter: (key, value) => (key === "clean" || key === "smudge" || key === "process") && !LFS_FILTERS.has(value ?? ""),
	pager: (_key, value) => !BOOLEAN.test(value ?? ""),
	gpg: (key) => key === "program",
	// An included file is not followed; it could hold any of the above.
	include: (key) => key === "path",
	includeif: (key) => key === "path",
};

/** One git config file's entries, section names lowercased without their subsection. */
function configEntries(text: string): { section: string; key: string; value: string | undefined }[] {
	const entries: { section: string; key: string; value: string | undefined }[] = [];
	let section = "";
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line);
		if (header) {
			// `[diff "x"]` and the old `[diff.x]` spelling both name section `diff`.
			section = header[1].split(".")[0].toLowerCase();
			line = line.slice(header[0].length).trim();
		}
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
		if (entry) entries.push({ section, key: entry[1].toLowerCase(), value: entry[2]?.trim().replace(/^"(.*)"$/, "$1") });
	}
	return entries;
}

/**
 * What one git config file's text names: the first program-valued key, as
 * `section.key`, and every `core.hooksPath`. A hooks path is not a program by
 * itself (husky sets one); the caller looks there for the hook a read runs.
 */
export function configRunsProgram(text: string): { program?: string; hooksPaths: string[] } {
	const hooksPaths: string[] = [];
	for (const { section, key, value } of configEntries(text)) {
		if (section === "core" && key === "hookspath" && value) hooksPaths.push(value);
		else if (PROGRAM_KEYS[section]?.(key, value)) return { program: `${section}.${key}`, hooksPaths };
	}
	return { hooksPaths };
}

/** The checkout holding `dir`: its worktree root, git dir and common dir, or undefined outside one. */
function checkoutOf(dir: string): { root: string; gitDir: string; commonDir: string } | undefined {
	const root = findGitRoot(dir);
	if (!root) return undefined;
	const gitDir = gitdirFileTarget(root) ?? join(root, ".git");
	let commonDir = gitDir;
	try {
		const common = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
		if (common) commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
	} catch {
		// Not a linked worktree: the git dir is the common dir.
	}
	return { root, gitDir, commonDir };
}

/** A missing file or directory, as opposed to one this process cannot read. */
function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Every submodule git dir `status` can recurse into, or undefined when the
 * search cannot finish (an unreadable directory, more than 200 repositories,
 * nesting past 32 levels), which the caller treats as a program. Found two
 * ways: the standard layout under `<commonDir>/modules` (a nested submodule's
 * under its parent's own `modules/`; a slashed submodule name is a directory
 * chain), and each `.gitmodules` path whose `.git` points somewhere else.
 */
function submoduleGitDirs(root: string, commonDir: string): string[] | undefined {
	const found = new Set<string>();
	const walk = (dir: string, depth: number): boolean => {
		if (depth > 32) return false;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			return isMissing(error);
		}
		if (entries.some((entry) => entry.name === "HEAD" || entry.name === "config")) {
			found.add(dir);
			return found.size <= 200 && walk(join(dir, "modules"), depth + 1);
		}
		return entries.every((entry) => !entry.isDirectory() || walk(join(dir, entry.name), depth + 1));
	};
	if (!walk(join(commonDir, "modules"), 0)) return undefined;
	let gitmodules = "";
	try {
		gitmodules = readFileSync(join(root, ".gitmodules"), "utf-8");
	} catch (error) {
		if (!isMissing(error)) return undefined;
	}
	for (const { section, key, value } of configEntries(gitmodules)) {
		if (section !== "submodule" || key !== "path" || !value) continue;
		const worktree = resolve(root, value);
		const dotGit = join(worktree, ".git");
		const gitDir = gitdirFileTarget(worktree) ?? (existsSync(dotGit) ? dotGit : undefined);
		if (gitDir) found.add(gitDir);
		if (found.size > 200) return undefined;
	}
	return [...found];
}

/** The hooks a git read can run: `status` rewrites the index. */
export const READ_HOOKS = ["post-index-change"] as const;

/**
 * The hooks `git reset --hard` can run: the index rewrite, and the ref update
 * when it moves HEAD. A clean tree made the reset recoverable, but a
 * recoverable reset still ran a configured hook unclassified
 * (AUTO-MODE-SECURITY-REVIEW-2026-09-24 M2).
 */
export const RESET_HOOKS = ["post-index-change", "reference-transaction"] as const;

/**
 * Why a git command in `dir` could run a program the checkout names, or
 * undefined when its repository-scoped configuration names none (or `dir` is
 * in no checkout). `hooks` are the hook names the command can run; `home`
 * expands a `~` hooks path.
 */
export function checkoutGitRunsProgram(dir: string, home: string, hooks: readonly string[] = READ_HOOKS): string | undefined {
	const checkout = checkoutOf(dir);
	if (!checkout) return undefined;
	const { root, gitDir, commonDir } = checkout;
	const modules = submoduleGitDirs(root, commonDir);
	if (!modules) return "the checkout's submodules cannot all be read";
	// `status` rewrites the index, which runs `post-index-change`; it recurses
	// into submodules, each with its own hooks directory.
	const hooksDirs = [join(commonDir, "hooks"), ...modules.map((module) => join(module, "hooks"))];
	for (const file of new Set([join(commonDir, "config"), join(commonDir, "config.worktree"), join(gitDir, "config.worktree")])) {
		const found = readConfig(file);
		if (!found) return "the checkout's git config cannot be read";
		if (found.program) return `the checkout's git config sets ${found.program}, which names a program git runs`;
		for (const path of found.hooksPaths) hooksDirs.push(resolve(root, expandTilde(path, home)));
	}
	for (const module of modules) {
		const found = readConfig(join(module, "config"));
		// A submodule's relative hooks path is resolved against a worktree this check does not map.
		if (!found || found.program || found.hooksPaths.length > 0) {
			return `a submodule's git config ${found ? `sets ${found.program ?? "core.hookspath"}, which names a program git runs` : "cannot be read"}`;
		}
	}
	const hook = hooks.find((name) => hooksDirs.some((dir) => existsSync(join(dir, name))));
	return hook && `the checkout has a ${hook} hook, which git runs`;
}

/** What a config file names; empty when it does not exist, undefined when it cannot be read. */
function readConfig(file: string): { program?: string; hooksPaths: string[] } | undefined {
	try {
		return configRunsProgram(readFileSync(file, "utf-8"));
	} catch (error) {
		return isMissing(error) ? { hooksPaths: [] } : undefined;
	}
}

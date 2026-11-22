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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findGitRoot, gitdirFileTarget } from "../context/git.ts";
import { expandTilde } from "../profile/paths.ts";

const BOOLEAN = /^(true|false|yes|no|on|off|1|0)?$/i;

/** git-lfs's own filter commands (`git lfs install`), resolved on the user's PATH. */
const LFS_FILTERS = new Set(["git-lfs clean -- %f", "git-lfs smudge -- %f", "git-lfs filter-process"]);

/** Keys whose value git runs during a read, by section (subsections included). */
const PROGRAM_KEYS: Record<string, (key: string, value: string | undefined) => boolean> = {
	// `core.fsmonitor=true` is git's own daemon; any other value is a hook command.
	core: (key, value) => (key === "fsmonitor" && !BOOLEAN.test(value ?? "")) || key === "pager",
	diff: (key) => key === "external" || key === "command" || key === "textconv",
	// A remote's `uploadpack` runs when a read of a partial clone meets a missing
	// object. (A merge driver runs only under `--remerge-diff`, which the
	// read-only tables do not list.)
	remote: (key) => key === "uploadpack" || key === "vcs",
	filter: (key, value) => (key === "clean" || key === "smudge" || key === "process") && !LFS_FILTERS.has(value ?? ""),
	pager: (_key, value) => !BOOLEAN.test(value ?? ""),
	gpg: (key) => key === "program",
	// An included file is not followed; it could hold any of the above.
	include: (key) => key === "path",
	includeif: (key) => key === "path",
};

/**
 * Keys a partial clone's fetch of a missing object reads (a checkout fetches
 * the blobs it writes), each naming a program the transport runs: the SSH
 * command, the `git://` proxy, the credential helper and askpass program an
 * HTTP remote's authentication runs, and what lets an `ext::` remote run its
 * command (a protocol policy that allows it, or an `ext::` URL, directly or
 * through `url.<base>.insteadOf`). `remote.<name>.uploadpack` and `.vcs` are
 * programs on every read ({@link PROGRAM_KEYS}).
 */
function fetchRunsProgram(section: string, subsection: string | undefined, key: string, value: string | undefined): boolean {
	const set = !!value;
	switch (section) {
		case "core":
			return set && (key === "sshcommand" || key === "gitproxy" || key === "askpass");
		case "credential":
			return set && key === "helper";
		case "protocol":
			// `protocol.allow` sets the default for every protocol, `ext` included.
			return key === "allow" && (subsection === undefined || subsection.toLowerCase() === "ext") && !/^never$/i.test(value ?? "");
		case "remote":
			return (key === "url" || key === "pushurl") && /^\s*ext::/i.test(value ?? "");
		case "url":
			return /^\s*ext::/i.test(subsection ?? "");
		default:
			return false;
	}
}

/** One git config file's entries, section names lowercased with their subsection apart. */
function configEntries(text: string): { section: string; subsection?: string; key: string; value: string | undefined }[] {
	const entries: { section: string; subsection?: string; key: string; value: string | undefined }[] = [];
	let section = "";
	let subsection: string | undefined;
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
		if (header) {
			// `[diff "x"]` and the old `[diff.x]` spelling both name section `diff`.
			const [name, ...rest] = header[1].split(".");
			section = name.toLowerCase();
			subsection = header[2]?.replace(/\\(.)/g, "$1") ?? (rest.length > 0 ? rest.join(".") : undefined);
			line = line.slice(header[0].length).trim();
		}
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
		if (entry) entries.push({ section, subsection, key: entry[1].toLowerCase(), value: entry[2]?.trim().replace(/^"(.*)"$/, "$1") });
	}
	return entries;
}

/**
 * What one git config file's text names: the first program-valued key, as
 * `section.key`, every `core.hooksPath`, the key that makes the checkout a
 * partial clone, and the first key a partial clone's fetch runs a program by
 * (`fetchProgram`, {@link fetchRunsProgram}). A hooks path is not a program
 * by itself (husky sets one); the caller looks there for the hook a read
 * runs. A fetch key is not one either until some config file of the checkout
 * makes it a partial clone, which the caller decides across its files.
 */
export function configRunsProgram(text: string): { program?: string; hooksPaths: string[]; promisor?: string; fetchProgram?: string } {
	const hooksPaths: string[] = [];
	let promisor: string | undefined;
	let fetchProgram: string | undefined;
	for (const { section, subsection, key, value } of configEntries(text)) {
		if (section === "core" && key === "hookspath" && value) hooksPaths.push(value);
		else if (PROGRAM_KEYS[section]?.(key, value)) return { program: `${section}.${key}`, hooksPaths };
		else if ((section === "remote" && (key === "promisor" || key === "partialclonefilter")) || (section === "extensions" && key === "partialclone")) promisor ??= `${section}.${key}`;
		else if (fetchRunsProgram(section, subsection, key, value)) fetchProgram ??= `${section}.${key}`;
	}
	return { hooksPaths, ...(promisor && { promisor }), ...(fetchProgram && { fetchProgram }) };
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

/** What in a checkout could make git run a program it names (worded by the profile's worktree guard). */
export type CheckoutProgram =
	/** A submodule's git directory cannot be read. */
	| { kind: "submodulesUnreadable" }
	| { kind: "configUnreadable" }
	/** The checkout's config sets `key` (a program git runs). */
	| { kind: "configSetsProgram"; key: string }
	/** A submodule's config sets `key`, or cannot be read (`key` absent). */
	| { kind: "submoduleConfig"; key?: string }
	/** `dir` has a repository's own layout (`HEAD`, `objects`, `refs`), so git reads the config beside them. */
	| { kind: "bareRepository"; dir: string }
	/** The checkout is a partial clone (`key`): a read of a missing object fetches from its remote. */
	| { kind: "promisorRemote"; key: string }
	/** The checkout has this hook, which git runs. */
	| { kind: "hook"; hook: string };

/**
 * Why a git command in `dir` could run a program the checkout names, or
 * undefined when its repository-scoped configuration names none (or `dir` is
 * in no checkout). `hooks` are the hook names the command can run; `home`
 * expands a `~` hooks path.
 */
export function checkoutGitRunsProgram(dir: string, home: string, hooks: readonly string[] = READ_HOOKS): CheckoutProgram | undefined {
	const checkout = checkoutOf(dir);
	// git takes a directory holding `HEAD`, `objects` and `refs` as a repository
	// before it looks further up, and runs what the `config` beside them names.
	// Those are ordinary names a clone can carry in any subdirectory, so one on
	// the way up to the checkout found is a program, unread.
	for (let at = resolve(dir); ; at = dirname(at)) {
		if (at !== checkout?.gitDir && at !== checkout?.commonDir && ["HEAD", "objects", "refs"].every((name) => existsSync(join(at, name)))) {
			return { kind: "bareRepository", dir: at };
		}
		if (at === checkout?.root || dirname(at) === at) break;
	}
	if (!checkout) return undefined;
	const { root, gitDir, commonDir } = checkout;
	const modules = submoduleGitDirs(root, commonDir);
	if (!modules) return { kind: "submodulesUnreadable" };
	// `status` rewrites the index, which runs `post-index-change`; it recurses
	// into submodules, each with its own hooks directory.
	const hooksDirs = [join(commonDir, "hooks"), ...modules.map((module) => join(module, "hooks"))];
	let promisor: string | undefined;
	let fetchProgram: CheckoutProgram | undefined;
	for (const file of new Set([join(commonDir, "config"), join(commonDir, "config.worktree"), join(gitDir, "config.worktree")])) {
		const found = readConfig(file);
		if (!found) return { kind: "configUnreadable" };
		if (found.program) return { kind: "configSetsProgram", key: found.program };
		promisor ??= found.promisor;
		if (found.fetchProgram) fetchProgram ??= { kind: "configSetsProgram", key: found.fetchProgram };
		for (const path of found.hooksPaths) hooksDirs.push(resolve(root, expandTilde(path, home)));
	}
	for (const module of modules) {
		const found = readConfig(join(module, "config"));
		// A submodule's relative hooks path is resolved against a worktree this check does not map.
		if (!found || found.program || found.hooksPaths.length > 0) {
			return found ? { kind: "submoduleConfig", key: found.program ?? "core.hookspath" } : { kind: "submoduleConfig" };
		}
		promisor ??= found.promisor;
		if (found.fetchProgram) fetchProgram ??= { kind: "submoduleConfig", key: found.fetchProgram };
	}
	const hook = hooks.find((name) => hooksDirs.some((dir) => existsSync(join(dir, name))));
	if (hook) return { kind: "hook", hook };
	if (!promisor) return undefined;
	// A partial clone's fetch of a missing object runs what its transport keys
	// name (`core.sshCommand`, a credential helper): a program the checkout
	// names, which no harness `-c` flag overrides.
	return fetchProgram ?? { kind: "promisorRemote", key: promisor };
}

/**
 * `checkoutGitRunsProgram` for a caller that runs git itself and only needs
 * to know whether the checkout names a program: a partial clone by itself
 * names none, but one whose fetch runs a program its config names (an SSH
 * command, a credential helper) comes back as that program.
 */
export function checkoutRunsOwnProgram(dir: string, home: string, hooks: readonly string[] = READ_HOOKS): CheckoutProgram | undefined {
	const program = checkoutGitRunsProgram(dir, home, hooks);
	return program?.kind === "promisorRemote" ? undefined : program;
}

/** What a config file names; empty when it does not exist, undefined when it cannot be read. */
function readConfig(file: string): ReturnType<typeof configRunsProgram> | undefined {
	try {
		return configRunsProgram(readFileSync(file, "utf-8"));
	} catch (error) {
		return isMissing(error) ? { hooksPaths: [] } : undefined;
	}
}

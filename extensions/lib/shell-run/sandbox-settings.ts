/**
 * The shell sandbox's settings: Claude Code's `sandbox` block, merged across
 * the settings ladder (lib/profile/settings-files.ts). Pure apart from reading
 * the files.
 *
 * A file the repository controls may only tighten the sandbox: it can turn
 * it on, add `denyRead`, `denyWrite` and `deniedDomains` entries, forbid
 * unsandboxed commands, and turn auto-allow off. What widens access (turning the sandbox off, write
 * and read allowances, network hosts, excluded commands, local binding, Unix
 * sockets) counts from the user's, the product's and managed files only, as
 * a repository's permission mode does (lib/rules/settings.ts).
 *
 * The paths of the permission deny rules join the sandbox's own deny lists,
 * as in Claude Code: an edit-family rule's path is never writable and a
 * `Read` rule's never readable from inside the sandbox, so a write the gate
 * cannot see in a command line (`sed -i`, a script) still cannot reach it.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isPlainObject } from "../core/plain-object.ts";
import { isRepoFile, readSettingsFile, settingsSources } from "../profile/settings-files.ts";
import { EDIT_TOOLS, hasUnescapedWildcard, type PermissionRule, parseRules, pathGlobRegex, unescapeLiteral } from "../rules/matcher.ts";
import { loadPermissionSettings } from "../rules/settings.ts";
import { walkTree } from "../shell/paths.ts";

export interface SandboxSettings {
	enabled: boolean;
	/** False: the model's `dangerouslyDisableSandbox` is ignored. Claude Code's default is true. */
	allowUnsandboxedCommands: boolean;
	/** Refuse shell commands when the sandbox is on and cannot start, in place of running them unsandboxed. */
	failIfUnavailable: boolean;
	/**
	 * True: a Bash command that will run inside the sandbox needs no prompt in
	 * the manual modes (Claude Code's auto-allow). Off by default, as in Claude
	 * Code: the sandbox adds its limits and every prompt stays.
	 */
	autoAllowBashIfSandboxed: boolean;
	/** Command patterns that run outside the sandbox (`docker compose *`). */
	excludedCommands: string[];
	filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] };
	network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: boolean; allowUnixSockets: string[] };
	/**
	 * The path patterns of the permission deny rules, as written: `write` from
	 * the edit family's (`Edit`, `Write`, `NotebookEdit`), `read` from `Read`'s.
	 * Turned into sandbox paths per command directory by {@link ruleDenyPaths}.
	 */
	denyRulePaths: { write: string[]; read: string[] };
}

export const SANDBOX_OFF: SandboxSettings = {
	enabled: false,
	allowUnsandboxedCommands: true,
	failIfUnavailable: false,
	autoAllowBashIfSandboxed: false,
	excludedCommands: [],
	filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
	network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
	denyRulePaths: { write: [], read: [] },
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : []);
const record = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
const add = (into: string[], more: string[]): void => {
	for (const entry of more) if (!into.includes(entry)) into.push(entry);
};

/** One file's `sandbox` block laid over `settings`; `repo` says the repository controls the file. */
export function mergeSandboxBlock(settings: SandboxSettings, block: unknown, repo: boolean): SandboxSettings {
	const sandbox = record(block);
	const filesystem = record(sandbox.filesystem);
	const network = record(sandbox.network);
	const next: SandboxSettings = {
		...settings,
		excludedCommands: [...settings.excludedCommands],
		filesystem: { allowWrite: [...settings.filesystem.allowWrite], denyWrite: [...settings.filesystem.denyWrite], denyRead: [...settings.filesystem.denyRead], allowRead: [...settings.filesystem.allowRead] },
		network: { ...settings.network, allowedDomains: [...settings.network.allowedDomains], deniedDomains: [...settings.network.deniedDomains], allowUnixSockets: [...settings.network.allowUnixSockets] },
	};
	// Tightening, from any file.
	if (sandbox.enabled === true) next.enabled = true;
	if (sandbox.allowUnsandboxedCommands === false) next.allowUnsandboxedCommands = false;
	if (sandbox.autoAllowBashIfSandboxed === false) next.autoAllowBashIfSandboxed = false;
	add(next.filesystem.denyWrite, strings(filesystem.denyWrite));
	add(next.filesystem.denyRead, strings(filesystem.denyRead));
	add(next.network.deniedDomains, strings(network.deniedDomains));
	if (repo) return next;
	// Widening, and the choices that are the user's alone.
	if (sandbox.enabled === false) next.enabled = false;
	if (sandbox.failIfUnavailable === true) next.failIfUnavailable = true;
	if (sandbox.autoAllowBashIfSandboxed === true) next.autoAllowBashIfSandboxed = true;
	add(next.excludedCommands, strings(sandbox.excludedCommands));
	add(next.filesystem.allowWrite, strings(filesystem.allowWrite));
	add(next.filesystem.allowRead, strings(filesystem.allowRead));
	add(next.network.allowedDomains, strings(network.allowedDomains));
	add(next.network.allowUnixSockets, strings(network.allowUnixSockets));
	if (network.allowLocalBinding === true) next.network.allowLocalBinding = true;
	return next;
}

/**
 * The session's sandbox settings. A user-scope `allowUnsandboxedCommands:
 * false` holds whatever a later file says, because the merge only ever
 * turns it off. The deny rules are the permission gate's own
 * (`loadPermissionSettings`), from every file: a deny only restricts, so a
 * repository's counts too.
 */
export function loadSandboxSettings(cwd: string, home: string): SandboxSettings {
	let settings = SANDBOX_OFF;
	for (const source of settingsSources(cwd, home)) {
		const block = readSettingsFile(source.path)?.sandbox;
		if (block !== undefined) settings = mergeSandboxBlock(settings, block, isRepoFile(source));
	}
	return { ...settings, denyRulePaths: denyRulePaths(parseRules(loadPermissionSettings(cwd, home).deny)) };
}

/**
 * The path patterns of `deny` that bind the sandbox: an edit-family rule's
 * for writes, a `Read` rule's for reads, as Claude Code's sandbox takes its
 * `Edit` and `Read` deny rules. A rule with no path (a bare `Edit`) names no
 * path, and Claude Code skips it too. Only deny rules are passed in: allow
 * and ask rules never reach the sandbox.
 */
export function denyRulePaths(deny: readonly PermissionRule[]): { write: string[]; read: string[] } {
	const paths = { write: [] as string[], read: [] as string[] };
	for (const rule of deny) {
		if (!rule.pattern) continue;
		if (EDIT_TOOLS.has(rule.tool)) add(paths.write, [rule.pattern]);
		else if (rule.tool === "read") add(paths.read, [rule.pattern]);
	}
	return paths;
}

/** What the runtime reads as glob syntax in a path: `*`, `?` and a bracket set. It has no escape character. */
const RUNTIME_GLOB = /[*?[\]]/;

/**
 * The directory `path` names before its first character that is glob syntax
 * to the gate or the runtime (a wildcard, an escape, `?`, a bracket): what a
 * deny falls back to where the runtime cannot hold the pattern itself. It
 * covers everything the pattern matches, and more.
 */
function literalDirectory(path: string): string {
	const cut = path.search(/[*?[\]\\]/);
	if (cut < 0) return path;
	const head = path.slice(0, cut);
	return head.slice(0, head.lastIndexOf("/")) || "/";
}

/** An entry of the runtime's path lists: a spelling, which it reads as a pattern when it holds `*`, `?` or a bracket, or a path marked literal, which it never reads as one. */
export type SandboxPathEntry = string | { path: string; literal: true };

/**
 * One path a deny rule names for a command, as {@link ruleDenyPaths} reads
 * it: `path` goes to the runtime as written; `literal` is an exact path that
 * holds characters the runtime would read as glob syntax, marked literal for
 * it; `expand` is a glob the runtime cannot hold on this platform, so each
 * command gets the files it matches when its rules are built
 * ({@link expandDenyGlobs}).
 */
export type RuleDenyPath = { kind: "path"; path: string } | { kind: "literal"; path: string } | { kind: "expand"; glob: string };

/**
 * The sandbox paths a deny rule's path pattern names, for a command run in
 * `cwd`, in the gate's rule syntax:
 *
 * - `//abs` is the absolute path `/abs`;
 * - `~/x` is under the home directory;
 * - `/x` is read both ways it is meant: the gate matches it as the absolute
 *   path, and Claude Code reads it against the project directory, so both are
 *   denied (a deny only ever narrows);
 * - anything else (`x`, `./x`, `../x`) is relative to `cwd`.
 *
 * Every path is absolute, since the runtime would read a relative one
 * against the process's directory, not the command's. A glob passes as
 * written where the runtime reads it as the gate does: `*` within a name and
 * `**` across directories, on macOS for both lists and on Linux for reads,
 * which the runtime expands against the disk. A write-deny glob on Linux is
 * expanded per command (bubblewrap binds only real paths, and the runtime
 * skips a write glob there).
 *
 * The gate takes a gate escape (`\*`), a `?` and a bracket literally, and
 * the runtime reads them as glob syntax. An exact path holding them goes to
 * the runtime marked literal. A glob holding them is expanded per command on
 * Linux, and on macOS widened to {@link literalDirectory}, never dropped. The
 * widening is not used for a Linux read: there the runtime binds a writable
 * folder back over a folder it hides, so a deny of the working directory
 * would hide nothing.
 */
export function ruleDenyPaths(pattern: string, kind: "write" | "read", cwd: string, home: string, platform: NodeJS.Platform): RuleDenyPath[] {
	// Never trimmed: the gate matches the pattern with its spaces, so `Read(secret.txt )` is the file whose name ends in one.
	const paths = pattern.startsWith("//")
		? [resolve(pattern.slice(1))]
		: pattern === "~" || pattern.startsWith("~/")
			? [resolve(home, `.${pattern.slice(1)}`)]
			: pattern.startsWith("/")
				? [resolve(pattern), resolve(cwd, `.${pattern}`)]
				: [resolve(cwd, pattern)];
	return paths.map((path): RuleDenyPath => {
		if (!hasUnescapedWildcard(path)) {
			const exact = unescapeLiteral(path);
			return RUNTIME_GLOB.test(exact) ? { kind: "literal", path: exact } : { kind: "path", path: exact };
		}
		const gateLiterals = /[?[\]\\]/.test(path);
		// The runtime ends a `/**` itself (the directory and all beneath it), which bubblewrap can bind.
		if (platform === "linux" && (gateLiterals || (kind === "write" && RUNTIME_GLOB.test(path.replace(/\/\*\*$/, ""))))) return { kind: "expand", glob: path };
		return { kind: "path", path: gateLiterals ? literalDirectory(path) : path };
	});
}

/** The most directory entries one walk of {@link expandDenyGlobs} visits (about 60 ms on a laptop's warm disk). */
export const DENY_GLOB_WALK_BUDGET = 20_000;

/**
 * The files each glob matches now, as literal entries for the runtime: what
 * a Linux write-deny glob becomes for one command, the way the runtime
 * expands a read-deny glob for each command. Globs that start in the same
 * directory share one walk of it ({@link walkTree}: no symbolic link
 * followed, `node_modules` and `.git` left out unless a glob names them, at
 * most `budget` entries). A path is matched as
 * the permission gate matches it (`pathGlobRegex`), so the sandbox denies
 * what the gate denies. A directory that matches is denied whole and not
 * walked further, as is one that cannot be listed; a glob that ends in `/**`
 * also matches the directory it names. A glob with no `**` is walked only as
 * deep as it reaches.
 *
 * A walk that runs out of budget gives each of its globs the directory it
 * starts in ({@link literalDirectory}), the widening that covers everything
 * the glob matches and more (for a Linux read that folder hides nothing when
 * it is writable, see {@link ruleDenyPaths}: a known limit for a folder past
 * the budget). A file created after the rules are built is not covered; the
 * expansion runs again for the next command.
 */
/**
 * Folders the walk stays out of unless a glob names one: a dependency tree or
 * git's object store alone runs past the budget, which gave every project
 * that has one the folder widening. A match inside them is left to the
 * permission gate.
 */
const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

export function expandDenyGlobs(globs: readonly string[], budget = DENY_GLOB_WALK_BUDGET): Map<string, SandboxPathEntry[]> {
	const byBase = new Map<string, string[]>();
	for (const glob of new Set(globs)) {
		const base = literalDirectory(glob);
		byBase.set(base, [...(byBase.get(base) ?? []), glob]);
	}
	const expanded = new Map<string, SandboxPathEntry[]>();
	for (const [base, group] of byBase) {
		const readings = group.map((glob) => ({
			glob,
			whole: pathGlobRegex(glob, false),
			directory: glob.endsWith("/**") ? pathGlobRegex(glob.slice(0, -3), false) : undefined,
			depth: glob.includes("**") ? Number.POSITIVE_INFINITY : glob.slice(base.length).split("/").filter(Boolean).length,
			found: [] as string[],
		}));
		const depth = Math.max(...readings.map((reading) => reading.depth));
		const outcome = walkTree(
			base,
			(relative, entry) => {
				const path = join(base, relative);
				let whole = false;
				for (const reading of readings) {
					if (!reading.whole.test(path) && !(entry.isDirectory() && reading.directory?.test(path))) continue;
					reading.found.push(path);
					whole ||= entry.isDirectory();
				}
				if (whole || relative.split(sep).length >= depth) return "skip";
				return entry.isDirectory() && UNWALKED_DIRECTORIES.has(entry.name) && !group.some((glob) => glob.includes(entry.name)) ? "skip" : undefined;
			},
			budget,
			(relative) => {
				for (const reading of readings) reading.found.push(join(base, relative));
			},
		);
		for (const reading of readings) expanded.set(reading.glob, outcome === "over budget" ? [literalDirectory(reading.glob)] : reading.found.map((path) => ({ path, literal: true as const })));
	}
	return expanded;
}

const SHELL_OPERATORS = /[;&|<>`\n]|\$\(/;

/**
 * Whether `command` is one of the user's excluded commands, which run outside
 * the sandbox. A pattern is the exact command or a prefix ending in ` *` or
 * `:*`. The whole call has to be the one plain command: anything with a
 * shell operator, a redirect or a substitution stays sandboxed, as in Claude
 * Code, so `docker ps; curl evil` is not excluded by `docker *`.
 */
export function isExcludedCommand(command: string, patterns: readonly string[]): boolean {
	const line = command.trim();
	if (line === "" || SHELL_OPERATORS.test(line)) return false;
	return patterns.some((raw) => {
		const pattern = raw.trim();
		const prefix = pattern.endsWith(":*") ? pattern.slice(0, -2) : pattern.endsWith(" *") ? pattern.slice(0, -2) : undefined;
		if (prefix === undefined) return line === pattern;
		return prefix !== "" && (line === prefix || line.startsWith(`${prefix} `));
	});
}

/** The most hosts one command may name for itself, and the longest of them (Claude Code's limits). */
export const COMMAND_HOSTS_MAX = 100;
export const COMMAND_HOST_MAX_LENGTH = 260;

/**
 * The hosts a shell call names for itself (`allowed_domains`): the non-empty
 * strings within the limits, without repeats. The tool's schema refuses a
 * list past the limits; a call that reached here another way gets only the
 * entries inside them.
 */
export function commandHosts(input: Record<string, unknown> | undefined): string[] {
	const hosts = strings(input?.allowed_domains).map((host) => host.trim()).filter((host) => host !== "" && host.length <= COMMAND_HOST_MAX_LENGTH);
	return [...new Set(hosts)].slice(0, COMMAND_HOSTS_MAX);
}

/** What the session gives the sandbox beyond the user's settings. */
export interface SandboxScope {
	/** The command's working directory (a worktree's, for a worktree session). */
	cwd: string;
	/** Other directories the session may write: the workspace directories, the sandbox's temp directory. */
	writableDirs: readonly string[];
	/** Files that configure the permission gate: never writable, whatever allows their directory. */
	protectedFiles: readonly string[];
}

/**
 * The contents of a small git file whose contents matter (a `.git` pointer,
 * a `commondir`). Opened without blocking and read only when it is a regular
 * file: a sandboxed command can put a FIFO at such a name, and an ordinary
 * open of one with no writer would hang the harness. A directory throws
 * `EISDIR` as a plain read does; anything else that is not a file throws too.
 */
export function readGitPointer(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (stat.isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: "EISDIR" });
		if (!stat.isFile()) throw Object.assign(new Error(`not a regular file: ${path}`), { code: "EINVAL" });
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * The git paths a command in a linked worktree writes outside the
 * worktree: its own git directory (index, HEAD, its logs), the shared
 * repository's objects, refs and logs, and its packed refs (`packed-refs` and
 * the lock it is written through: a commit's automatic maintenance packs the
 * refs). Without them `git add` and `git commit` fail in a worktree session
 * and in an isolated subagent. (On Linux the runtime skips a path that does
 * not exist yet, so packing the refs still fails there.) Empty for
 * an ordinary checkout, whose `.git` is inside the working directory, and
 * for no repository. The shared repository's `hooks` and `config` are not
 * in the list, so they stay unwritable.
 *
 * The `.git` file that names the git directory sits in the worktree, where a
 * sandboxed command can rewrite it, so it is believed only when the git
 * directory names this worktree back (its `gitdir` file, which git writes
 * and no sandboxed command can). Git writes that path with symlinks resolved
 * (macOS's `/var/folders/…` temp dir, where an isolated subagent's worktree
 * lives, is `/private/var/folders/…`), so the two are compared as real
 * directories. Only the directory is resolved, never the `.git` entry
 * itself: a `.git` symlink planted in another directory does not make it the
 * worktree.
 */
export function linkedWorktreeGitDirs(dir: string, read: (path: string) => string = readGitPointer, real: (path: string) => string = realpathSync): string[] {
	const sameDir = (a: string, b: string) => {
		try {
			return real(a) === real(b);
		} catch {
			return false;
		}
	};
	for (let root = resolve(dir); ; root = dirname(root)) {
		const dotGit = join(root, ".git");
		try {
			const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit))?.[1]?.trim();
			if (!pointer) return [];
			const gitDir = resolve(root, pointer);
			const named = resolve(gitDir, read(join(gitDir, "gitdir")).trim());
			if (named !== dotGit && !(basename(named) === ".git" && sameDir(dirname(named), root))) return [];
			const common = resolve(gitDir, read(join(gitDir, "commondir")).trim());
			return [gitDir, join(common, "objects"), join(common, "refs"), join(common, "logs"), join(common, "packed-refs"), join(common, "packed-refs.lock")];
		} catch (error) {
			// A directory `.git` is an ordinary checkout; anything else unreadable ends the search here too.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(root) === root) return [];
		}
	}
}

/**
 * The files of the checkout holding `dir` that run or steer a program outside
 * the sandbox once written, to deny whatever allows the directory.
 *
 * The runtime denies its own list (`.git/hooks`, `.git/config`, the shell and
 * git startup files, `.mcp.json`, `.vscode`, `.idea`), but anchors it at the
 * process's directory. A session of another directory, a workspace directory
 * and an isolated subagent's worktree get none of it, so the same names are
 * listed here under `dir` and under its checkout's root.
 *
 * The runtime's list also misses what redirects git itself. Git takes its
 * config from the directory a git dir's `commondir` file names, and a
 * worktree's from where its `.git` file and `gitdir` back-reference point, so
 * a sandboxed command that writes one makes the harness's own `git status`
 * (session start, an isolated agent's hand-back) run a filter or fsmonitor
 * command of its choosing. `info/attributes` assigns such a filter, and
 * `config.worktree` is config. pi loads `.pi` (extensions, settings) into the
 * harness at the next start. The names that make git take `dir` itself for
 * a bare repository are in {@link bareRepositoryFiles}.
 */
export function checkoutProtectedFiles(dir: string, read: (path: string) => string = readGitPointer, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = pathExists): string[] {
	return allCheckoutProtectedFiles(dir, read, platform).filter((path) => !absentOnLinux(path, exists, platform));
}

/**
 * Whether anything is at `path`, read from its metadata alone: a final
 * symbolic link is not followed and nothing is opened, so a FIFO is never
 * waited on and a large file never read. Only a missing path (or a missing
 * directory on the way) is nothing; one that cannot be looked at for another
 * reason counts as there, which keeps it denied.
 */
export function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/**
 * A path nothing exists at, on Linux. bubblewrap denies a missing path by
 * binding an empty device over it for the length of the command, and the
 * command sees that stub: git lists each one in the working tree as an
 * untracked file and `git add -A` fails on it ("can only add regular
 * files"), and a stub at a git dir's `commondir` fails every git command
 * ("failed to read .git/commondir: Permission denied"). So on Linux only the
 * names that exist are denied, as the runtime does for its own built-in
 * list, and a missing one can be created by a sandboxed command there. The
 * one that redirects the harness's own git, `commondir`, is removed when the
 * command ends ({@link plantableCommondirs}). macOS denies by rule, with
 * nothing put at the path, so it denies the missing names too.
 */
function absentOnLinux(path: string, exists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
	return platform === "linux" && !exists(path);
}

/**
 * The `commondir` paths of `dir`'s checkout that the Linux sandbox cannot
 * deny because nothing exists there. An ordinary checkout has none, so
 * whatever appears at one while a sandboxed command runs was planted by it;
 * the runner removes it when the command ends. A linked worktree's
 * `commondir` exists and stays denied. Empty on macOS.
 */
export function plantableCommondirs(dir: string, read: (path: string) => string = readGitPointer, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = pathExists): string[] {
	return allCheckoutProtectedFiles(dir, read, platform).filter((path) => basename(path) === "commondir" && absentOnLinux(path, exists, platform));
}

/**
 * Whether git would take `dir` itself for a repository: a `HEAD` file beside
 * `objects` and `refs` directories. The Linux sandbox cannot deny those names
 * while they are missing ({@link checkoutProtectedFiles}), so the runner
 * checks before and after a command and sets a planted `HEAD` aside.
 */
export function looksLikeBareRepository(dir: string): boolean {
	try {
		return lstatSync(join(dir, "HEAD")).isFile() && statSync(join(dir, "objects")).isDirectory() && statSync(join(dir, "refs")).isDirectory();
	} catch {
		return false;
	}
}

function allCheckoutProtectedFiles(dir: string, read: (path: string) => string, platform: NodeJS.Platform): string[] {
	const ROOT_NAMES = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".vscode", ".idea", ".pi"];
	const gitDirFiles = (gitDir: string) => ["commondir", "gitdir", "config.worktree"].map((name) => join(gitDir, name));
	const commonFiles = (common: string) => ["hooks", "config", join("info", "attributes")].map((name) => join(common, name));
	const found = new Set([...ROOT_NAMES.map((name) => join(dir, name)), ...bareRepositoryFiles(dir, platform)]);
	for (let root = resolve(dir); ; root = dirname(root)) {
		const dotGit = join(root, ".git");
		let pointer: string | undefined;
		try {
			pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit))?.[1]?.trim();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				if (dirname(root) === root) break;
				continue;
			}
			// A directory: an ordinary checkout, its own git dir and common dir.
			for (const name of ROOT_NAMES) found.add(join(root, name));
			for (const file of [...gitDirFiles(dotGit), ...commonFiles(dotGit)]) found.add(file);
			break;
		}
		for (const name of ROOT_NAMES) found.add(join(root, name));
		// A linked worktree: the pointer file itself, and both ends of what it names.
		found.add(dotGit);
		if (pointer) {
			const gitDir = resolve(root, pointer);
			for (const file of gitDirFiles(gitDir)) found.add(file);
			try {
				const common = resolve(gitDir, read(join(gitDir, "commondir")).trim());
				for (const file of [...gitDirFiles(common), ...commonFiles(common)]) found.add(file);
			} catch {
				// No common dir to read: the git dir is its own.
				for (const file of commonFiles(gitDir)) found.add(file);
			}
		}
		break;
	}
	return [...found];
}

/**
 * The paths in `dir` that would let a sandboxed command make git take `dir`
 * itself for a bare repository: git does when it finds `HEAD`, `objects/`
 * and `refs/` there, and then runs that directory's `config` (an fsmonitor
 * or filter command) and `hooks` for the harness's own git outside the
 * sandbox. Claude Code's sandbox protects the same names, and this follows
 * what it does with each (2.1.330):
 *
 * - `objects` and `refs` are never writable. Where they are missing, Claude
 *   Code denies them on macOS and deletes them after each command on Linux;
 *   One Code denies them on both (on Linux the runtime holds an empty mount
 *   point there while the command runs), so the three names are never all
 *   there and git never takes `dir` for a repository.
 * - `HEAD` is never writable when it exists. A missing one is denied on
 *   macOS only: on Linux the runtime's mount point would be a file named
 *   `HEAD` in the directory, and git inside the command would then read
 *   `git log HEAD` as ambiguous between the revision and that file.
 * - `hooks` and `config` are denied when they exist and `HEAD` exists as
 *   something other than a folder, and a `config` that is a file always
 *   (with the `config.lock` git writes it through). An ordinary project's
 *   `config/` or `hooks/` folder stays writable; only a `.git` inside it is
 *   denied, as Claude Code does. A missing one is left alone.
 *
 * What exists is read when the command's scope is built, so the answers
 * hold until the scope is built again.
 */
export function bareRepositoryFiles(dir: string, platform: NodeJS.Platform = process.platform): string[] {
	const kind = (path: string, follow = false): "directory" | "other" | undefined => {
		try {
			return (follow ? statSync(path) : lstatSync(path)).isDirectory() ? "directory" : "other";
		} catch {
			return undefined;
		}
	};
	const at = (name: string) => join(dir, name);
	const found = [at("objects"), at("refs")];
	if (platform === "darwin" || kind(at("HEAD"), true) !== undefined) found.push(at("HEAD"));
	const head = kind(at("HEAD"));
	for (const name of ["hooks", "config"]) {
		const what = kind(at(name));
		if (what === undefined) continue;
		const configFile = name === "config" && what === "other";
		if (configFile || (head !== undefined && head !== "directory")) {
			found.push(at(name));
			if (configFile) found.push(at("config.lock"));
		} else if (what === "directory" && kind(join(at(name), ".git")) !== undefined) found.push(join(at(name), ".git"));
	}
	return found;
}

/** Where a command's rules are built: the home directory `~/` names, and the platform that decides what a glob can be. */
export interface SandboxHost {
	home?: string;
	platform?: NodeJS.Platform;
}

/** A command's filesystem rules: writes are allow-only, reads deny-only. */
export interface SandboxFilesystem<Entry = string> {
	allowWrite: Entry[];
	denyWrite: Entry[];
	denyRead: Entry[];
	allowRead: Entry[];
}

/** The settings' lists and the deny rules' paths for a command run in `scope.cwd`, with each rule path as {@link ruleDenyPaths} reads it. */
function filesystemRules(settings: SandboxSettings, scope: SandboxScope, host: SandboxHost): SandboxFilesystem<string | RuleDenyPath> {
	const home = host.home ?? homedir();
	const platform = host.platform ?? process.platform;
	const fromRules = (patterns: readonly string[], kind: "write" | "read") => patterns.flatMap((pattern) => ruleDenyPaths(pattern, kind, scope.cwd, home, platform));
	const shadowed = new Set(shadowedAllowRead(settings, scope.cwd, host));
	return {
		allowWrite: [scope.cwd, ...scope.writableDirs, ...settings.filesystem.allowWrite],
		denyWrite: [...scope.protectedFiles, ...settings.filesystem.denyWrite, ...fromRules(settings.denyRulePaths.write, "write")],
		denyRead: [...settings.filesystem.denyRead, ...fromRules(settings.denyRulePaths.read, "read")],
		allowRead: settings.filesystem.allowRead.filter((entry) => !shadowed.has(entry)),
	};
}

/**
 * The settings' `allowRead` entries that a `Read` deny rule's path covers,
 * for a command run in `cwd`. The runtime lets an allowRead entry win over a
 * read deny it names or lies inside (a carve-out), so such an entry would
 * make a file the permission gate denies readable inside the sandbox; the
 * builder drops it, since a permission deny wins. An entry that only holds a
 * denied path (`allowRead: ["~/proj"]` with `Read(~/proj/.env)`) stays: the
 * runtime keeps a deny inside a broader allow. An entry the runtime reads as
 * a glob is dropped when its folder and a deny's overlap at all, since what
 * it matches cannot be told apart from the deny's. (A write needs none of
 * this: the runtime's write denies always win over its write allows.)
 */
export function shadowedAllowRead(settings: SandboxSettings, cwd: string, host: SandboxHost = {}): string[] {
	if (settings.denyRulePaths.read.length === 0 || settings.filesystem.allowRead.length === 0) return [];
	const home = host.home ?? homedir();
	const platform = host.platform ?? process.platform;
	const fold = platform === "darwin" || platform === "win32";
	const same = (path: string) => (fold ? path.toLowerCase() : path);
	const atOrUnder = (path: string, dir: string) => same(path) === same(dir) || same(path).startsWith(`${same(dir).replace(/\/+$/, "")}/`);
	const denies = settings.denyRulePaths.read.flatMap((pattern) => ruleDenyPaths(pattern, "read", cwd, home, platform));
	return settings.filesystem.allowRead.filter((entry) => {
		const path = entry === "~" || entry.startsWith("~/") ? resolve(home, `.${entry.slice(1)}`) : resolve(cwd, entry);
		const allowGlob = RUNTIME_GLOB.test(path);
		const allowBase = allowGlob ? literalDirectory(path) : path;
		return denies.some((deny) => {
			if (deny.kind !== "expand" && !(deny.kind === "path" && hasUnescapedWildcard(deny.path))) return atOrUnder(allowBase, deny.path) || (allowGlob && atOrUnder(deny.path, allowBase));
			const glob = deny.kind === "expand" ? deny.glob : deny.path;
			const base = literalDirectory(glob);
			if (allowGlob) return atOrUnder(allowBase, base) || atOrUnder(base, allowBase);
			// The allow is a path: covered when it, or a folder above it, matches the deny glob as the gate reads it.
			const regex = pathGlobRegex(glob, fold);
			for (let at = path; ; at = dirname(at)) {
				if (regex.test(at)) return true;
				if (dirname(at) === at) return false;
			}
		});
	});
}

const mapLists = <A, B>(lists: SandboxFilesystem<A>, entries: (entry: A) => B[]): SandboxFilesystem<B> => ({
	allowWrite: lists.allowWrite.flatMap(entries),
	denyWrite: lists.denyWrite.flatMap(entries),
	denyRead: lists.denyRead.flatMap(entries),
	allowRead: lists.allowRead.flatMap(entries),
});

/** Each list with every entry once, a literal one told apart by its path. */
function uniqueLists<Entry extends SandboxPathEntry>(lists: SandboxFilesystem<Entry>): SandboxFilesystem<Entry> {
	const unique = (entries: Entry[]): Entry[] => {
		const seen = new Set<string>();
		return entries.filter((entry) => {
			const key = typeof entry === "string" ? `s:${entry}` : `l:${entry.path}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};
	return { allowWrite: unique(lists.allowWrite), denyWrite: unique(lists.denyWrite), denyRead: unique(lists.denyRead), allowRead: unique(lists.allowRead) };
}

/**
 * The filesystem rules of a command run in `scope.cwd`, as the model's
 * sandbox section and `/sandbox` show them. The deny rules' paths come after
 * the settings' own lists, as in Claude Code. A glob expanded per command
 * (a Linux write-deny glob) is shown as its pattern, so the text depends only
 * on the settings and the directory and stays the same from one command to
 * the next.
 */
export function sandboxFilesystem(settings: SandboxSettings, scope: SandboxScope, host: SandboxHost = {}): SandboxFilesystem {
	return uniqueLists(mapLists(filesystemRules(settings, scope, host), (entry) => [typeof entry === "string" ? entry : entry.kind === "expand" ? entry.glob : entry.path]));
}

/**
 * The filesystem rules handed to the runtime for one command about to start
 * in `scope.cwd`: {@link sandboxFilesystem}'s rules with each per-command glob
 * expanded to the files it matches now ({@link expandDenyGlobs}). Built for
 * every wrap, so a file that appeared since the last command is denied from
 * this one on; one created while the command runs is not.
 */
export function sandboxCommandFilesystem(settings: SandboxSettings, scope: SandboxScope, host: SandboxHost = {}): SandboxFilesystem<SandboxPathEntry> {
	const rules = filesystemRules(settings, scope, host);
	const globs = [...rules.denyWrite, ...rules.denyRead].flatMap((entry) => (typeof entry !== "string" && entry.kind === "expand" ? [entry.glob] : []));
	const expanded = globs.length > 0 ? expandDenyGlobs(globs) : new Map<string, SandboxPathEntry[]>();
	const entries = (entry: string | RuleDenyPath): SandboxPathEntry[] => {
		if (typeof entry === "string") return [entry];
		if (entry.kind === "path") return [entry.path];
		if (entry.kind === "literal") return [{ path: entry.path, literal: true }];
		return expanded.get(entry.glob) ?? [literalDirectory(entry.glob)];
	};
	return uniqueLists(mapLists(rules, entries));
}

/** The session's configuration for the runtime's `initialize`: the rules of a command in `scope.cwd` at this moment. */
export function sandboxRuntimeConfig(settings: SandboxSettings, scope: SandboxScope, host: SandboxHost = {}) {
	return {
		network: {
			allowedDomains: [...settings.network.allowedDomains],
			deniedDomains: [...settings.network.deniedDomains],
			...(settings.network.allowLocalBinding ? { allowLocalBinding: true } : {}),
			...(settings.network.allowUnixSockets.length > 0 ? { allowUnixSockets: [...settings.network.allowUnixSockets] } : {}),
		},
		filesystem: sandboxCommandFilesystem(settings, scope, host),
	};
}

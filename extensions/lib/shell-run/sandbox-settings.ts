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
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPlainObject } from "../core/plain-object.ts";
import { isRepoFile, readSettingsFile, settingsSources } from "../profile/settings-files.ts";

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
}

export const SANDBOX_OFF: SandboxSettings = {
	enabled: false,
	allowUnsandboxedCommands: true,
	failIfUnavailable: false,
	autoAllowBashIfSandboxed: false,
	excludedCommands: [],
	filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
	network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
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
 * turns it off.
 */
export function loadSandboxSettings(cwd: string, home: string): SandboxSettings {
	let settings = SANDBOX_OFF;
	for (const source of settingsSources(cwd, home)) {
		const block = readSettingsFile(source.path)?.sandbox;
		if (block !== undefined) settings = mergeSandboxBlock(settings, block, isRepoFile(source));
	}
	return settings;
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
 * The git directories a command in a linked worktree writes outside the
 * worktree: its own git directory (index, HEAD, its logs) and the shared
 * repository's objects, refs and logs. Without them `git add` and `git
 * commit` fail in a worktree session and in an isolated subagent. Empty for
 * an ordinary checkout, whose `.git` is inside the working directory, and
 * for no repository. The shared repository's `hooks` and `config` are not
 * in the list, so they stay unwritable.
 *
 * The `.git` file that names the git directory sits in the worktree, where a
 * sandboxed command can rewrite it, so it is believed only when the git
 * directory names this worktree back (its `gitdir` file, which git writes
 * and no sandboxed command can).
 */
export function linkedWorktreeGitDirs(dir: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string[] {
	for (let root = resolve(dir); ; root = dirname(root)) {
		const dotGit = join(root, ".git");
		try {
			const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit))?.[1]?.trim();
			if (!pointer) return [];
			const gitDir = resolve(root, pointer);
			if (resolve(gitDir, read(join(gitDir, "gitdir")).trim()) !== dotGit) return [];
			const common = resolve(gitDir, read(join(gitDir, "commondir")).trim());
			return [gitDir, join(common, "objects"), join(common, "refs"), join(common, "logs")];
		} catch (error) {
			// A directory `.git` is an ordinary checkout; anything else unreadable ends the search here too.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(root) === root) return [];
		}
	}
}

/** The filesystem rules of one command, in the runtime's shape. Writes are allow-only; reads are deny-only. */
export function sandboxFilesystem(settings: SandboxSettings, scope: SandboxScope): { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] } {
	return {
		allowWrite: [...new Set([scope.cwd, ...scope.writableDirs, ...settings.filesystem.allowWrite])],
		denyWrite: [...new Set([...scope.protectedFiles, ...settings.filesystem.denyWrite])],
		denyRead: [...settings.filesystem.denyRead],
		allowRead: [...settings.filesystem.allowRead],
	};
}

/** The session's configuration for the runtime's `initialize`. */
export function sandboxRuntimeConfig(settings: SandboxSettings, scope: SandboxScope) {
	return {
		network: {
			allowedDomains: [...settings.network.allowedDomains],
			deniedDomains: [...settings.network.deniedDomains],
			...(settings.network.allowLocalBinding ? { allowLocalBinding: true } : {}),
			...(settings.network.allowUnixSockets.length > 0 ? { allowUnixSockets: [...settings.network.allowUnixSockets] } : {}),
		},
		filesystem: sandboxFilesystem(settings, scope),
	};
}

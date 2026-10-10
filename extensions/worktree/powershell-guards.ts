/**
 * Worktree-session guards for the `powershell` tool (pure): the same two
 * invariants guards.ts enforces for bash (git must verifiably target this
 * session's worktree; shared-stash forms that collide with a concurrent
 * session are refused), judged on PowerShell's statement split
 * (permissions/powershell-rules.ts). On Windows PowerShell is the primary
 * shell, so without this the invariant did not hold where it matters most.
 *
 * Conservative in the one direction that matters: git in a line the split
 * cannot follow (a script block, `$(…)`, a call operator, `Invoke-Expression`,
 * a nested shell, backtick escapes), after a directory change it cannot
 * resolve, or next to a GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR setting is
 * refused, naming the plain form that passes. A line without git passes.
 * Steering, not security: the permission gate still judges every command.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { toAbsolute } from "../auto-mode/paths.ts";
import { gitSubcommand } from "../auto-mode/shell-analysis.ts";
import { powershellInjectionSyntax, powershellStatements, statementCommand } from "../permissions/powershell-rules.ts";
import { containsPath, isolated, sharedRepositoryRoots, stashReason, type WorktreeGuardContext } from "./guards.ts";

/** git as a word (`git`, `GIT`, `git.exe`); PowerShell resolves commands case-insensitively. */
const mentionsGit = (text: string) => /\bgit(?:\.exe)?\b/i.test(text);

/** The repository variables, in any spelling (`$env:GIT_DIR = …`, `Set-Item env:GIT_WORK_TREE`, `[Environment]::SetEnvironmentVariable('GIT_DIR', …)`). */
const REPOSITORY_ENV = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b/i;

/** The words of one statement, quotes removed (`'…'` literal, `"…"` with doubled quotes). */
function statementWords(statement: string): string[] {
	const words: string[] = [];
	const pattern = /'((?:[^']|'')*)'|"((?:[^"]|"")*)"|([^\s'"]+)/g;
	let end = 0;
	for (const match of statement.matchAll(pattern)) {
		const value = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2] !== undefined ? match[2].replace(/""/g, '"') : match[3];
		// Quotes can start mid-word: --git-dir="C:\\my repo\\.git" is one argument.
		if (words.length > 0 && match.index === end) words[words.length - 1] += value;
		else words.push(value);
		end = match.index + match[0].length;
	}
	return words;
}

/** A PowerShell path word resolved against `dir`: `~` and `~\` expand, a drive or UNC path stands alone. */
function resolvePowershellPath(dir: string, word: string): string {
	const home = homedir();
	const tilde = word === "~" || word.startsWith("~/") || word.startsWith("~\\") ? `~/${word.slice(2)}` : word;
	if (/^[A-Za-z]:[\\/]/.test(tilde) || tilde.startsWith("\\\\") || isAbsolute(tilde)) return resolve(tilde);
	return toAbsolute(dir, tilde === "~/" ? "~" : tilde, home);
}

/** Values PowerShell expands at runtime (a variable, a subexpression) or a wildcard `-Path` matches. */
const dynamicPath = (word: string) => /[$`*?[]/.test(word);

/** Location parameters that take a value, besides the path itself. */
const LOCATION_VALUE_PARAMETERS = /^-(?:erroraction|ea|warningaction|wa|informationaction|infa|stackname|errorvariable|ev|warningvariable|wv|informationvariable|iv|outvariable|ov)$/i;
const PATH_PARAMETER = /^-(?:literalpath|path|lp|pspath)(?::(.+))?$/i;

/** The directory a `Set-Location` / `Push-Location` statement moves to, as written; undefined when none is named. */
function locationTarget(args: string[]): string | undefined {
	let positional: string | undefined;
	for (let j = 0; j < args.length; j++) {
		const word = args[j];
		const named = PATH_PARAMETER.exec(word);
		if (named) return named[1] ?? args[j + 1] ?? "";
		if (LOCATION_VALUE_PARAMETERS.test(word)) j++;
		else if (!word.startsWith("-") || word === "-") positional ??= word;
	}
	return positional;
}

export function worktreePowershellGuardReason(context: WorktreeGuardContext): string | undefined {
	const { command, worktreePath } = context;
	const sharedRoots = sharedRepositoryRoots(context);
	if (!mentionsGit(command)) return undefined;
	const plainGit = `Run git as its own plain statement, with literal paths inside ${worktreePath} (no script blocks, call operators or nested shells).`;

	const statements = powershellStatements(command);
	if (statements === undefined) {
		return isolated(worktreePath, "this command's quoting could not be followed, so the repository its git commands target cannot be verified", plainGit);
	}
	const syntax = powershellInjectionSyntax(command);
	if (syntax) {
		return isolated(worktreePath, `this command runs git next to ${syntax}, so the repository it targets cannot be verified`, plainGit);
	}
	if (REPOSITORY_ENV.test(command)) {
		return isolated(
			worktreePath,
			"this command sets GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR, which can point git at another repository",
			`Drop the variable and run git from ${worktreePath}.`,
		);
	}

	/** Directory the current statement runs in; undefined = not statically known. */
	let dir: string | undefined = worktreePath;
	for (const statement of statements) {
		const cmd = statementCommand(statement);
		const [, ...args] = statementWords(statement);

		if (cmd === "set-location" || cmd === "push-location") {
			const target = locationTarget(args);
			const absolute = target !== undefined && (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\") || isAbsolute(target));
			// No argument: pwsh 7 goes home. `-`/`+` walk the location history, which is not known here.
			if (target === undefined) dir = args.length === 0 ? homedir() : undefined;
			else if (!target || target === "-" || target === "+" || dynamicPath(target)) dir = undefined;
			// A relative move from an unknown directory stays unknown; an absolute one re-anchors.
			else if (dir !== undefined || absolute) dir = resolvePowershellPath(dir ?? worktreePath, target);
			continue;
		}
		if (cmd === "pop-location") {
			dir = undefined;
			continue;
		}
		if (cmd !== "git") continue;

		if (dir === undefined) {
			return isolated(worktreePath, "a preceding directory change makes the repository this git command targets unverifiable", `Use literal paths inside ${worktreePath} instead.`);
		}

		let effective = dir;
		const extraTargets: string[] = [];
		let i = 0;
		while (i < args.length && args[i].startsWith("-")) {
			const word = args[i];
			const lower = word.toLowerCase();
			const pathFlag = word === "-C" || lower === "--git-dir" || lower === "--work-tree";
			const inlined = lower.startsWith("--git-dir=") || lower.startsWith("--work-tree=");
			const configWorktree = word === "-c" && /^core\.worktree=/i.test(args[i + 1] ?? "");
			if (lower === "--config-env" || lower.startsWith("--config-env=")) {
				return isolated(worktreePath, "`git --config-env` reads its configuration at runtime, so the repository it targets cannot be verified", `Use literal paths inside ${worktreePath} instead.`);
			}
			if (pathFlag || inlined || configWorktree) {
				const raw = inlined ? word.slice(word.indexOf("=") + 1) : configWorktree ? args[i + 1].slice(args[i + 1].indexOf("=") + 1) : args[i + 1];
				if (!raw || dynamicPath(raw)) {
					return isolated(worktreePath, `\`git ${word}\` computes its repository target at runtime, so it cannot be verified`, `Use literal paths inside ${worktreePath} instead.`);
				}
				const target = resolvePowershellPath(effective, raw);
				if (word === "-C") effective = target;
				else extraTargets.push(target);
				i += inlined ? 1 : 2;
				continue;
			}
			i += word === "-c" || lower === "--namespace" || lower === "--exec-path" ? 2 : 1;
		}

		const targets = [effective, ...extraTargets];
		for (const target of targets) {
			if (containsPath(worktreePath, target)) continue;
			if (sharedRoots.some((root) => containsPath(root, target))) {
				return isolated(
					worktreePath,
					`this git command targets ${target}, which is the shared checkout or another worktree of the same repository`,
					`Run the equivalent against ${worktreePath}.`,
				);
			}
		}
		if (targets.some((target) => containsPath(worktreePath, target))) {
			const { sub, rest } = gitSubcommand(args.map((value) => ({ value })));
			if (sub === "stash") {
				const reason = stashReason(rest);
				if (reason) return reason;
			}
		}
	}
	return undefined;
}

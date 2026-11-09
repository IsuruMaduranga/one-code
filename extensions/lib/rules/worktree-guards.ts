/**
 * Worktree-session bash guards (pure).
 *
 * While enter_worktree isolation is active, other sessions may be working in
 * the shared checkout and in sibling worktrees at the same time. Two
 * invariants are enforced on bash commands BEFORE execution (and before the
 * permission prompt — the guard runs in the same tool_call hook that rewrites
 * inputs, which loads ahead of the permission gate):
 *
 * 1. Git operations must verifiably target this session's own worktree. A git
 *    whose repository is decided at runtime (`xargs`/`parallel`/`find -exec`
 *    feeding it arguments, a `-C "$DIR"` computed from a variable, a `cd`
 *    whose destination cannot be resolved), or that points into the shared
 *    checkout or a sibling worktree (`git -C`, `--git-dir`, `--work-tree`,
 *    `-c core.worktree=`, a `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`
 *    assignment before git or exported earlier in the line, a preceding
 *    `cd`), is refused with the fix named. Git against an unrelated
 *    repository elsewhere on disk is left alone — the permission gate and
 *    auto-mode still apply to it.
 * 2. The stash stack is shared by the main checkout and every worktree of the
 *    repository, and parallel sessions can interleave on it. Stash forms that
 *    collide with a concurrent session (untagged push, `pop`, `clear`,
 *    ref-less `drop` and `branch`) are refused with the tag + apply-by-SHA recipe.
 *
 * Steering, not security: bash (and `monitor`, which runs bash) is inspected
 * here, PowerShell in powershell-guards.ts, and an unparseable command is
 * refused only when it visibly involves git (fail closed on the invariant,
 * fail open on everything else).
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { isWithin, resolveForContainment, toAbsoluteBash } from "../shell/paths.ts";
import type { GitTargetProblem, StashRisk, WorktreeGuardRefusal } from "../../worktree/text.ts";
import { gitSubcommand, INLINE_SCRIPT_SHELLS, isUnknownTilde, leadTokens, LOOPS, movesDirectory, parseCommand, resolvePayload, scopedTracker, type Token } from "../shell/shell-analysis.ts";

export interface WorktreeGuardContext {
	command: string;
	/** The isolated worktree this session works in. */
	worktreePath: string;
	/** Root of the shared checkout the worktree belongs to. */
	sharedRoot: string;
	/**
	 * Every worktree of the repository (`git worktree list`). A linked worktree
	 * can live outside the shared root, and git aimed at it is refused too.
	 */
	otherWorktrees?: readonly string[];
}

/**
 * Whether a git target lies in a root, judged where both resolve: git lists
 * worktrees by their real paths (`/private/var/…` on macOS) while the session
 * and the model may spell a directory through a link (`/var/…`), and a link
 * inside one worktree may lead anywhere. Lexical only when resolution fails.
 */
export const containsPath = (root: string, target: string): boolean => {
	const resolvedRoot = resolveForContainment(root);
	const resolvedTarget = resolveForContainment(target);
	return resolvedRoot !== undefined && resolvedTarget !== undefined ? isWithin(resolvedRoot, resolvedTarget) : isWithin(root, target);
};

/** The roots a git command must not target: the shared checkout and every other worktree. */
export const sharedRepositoryRoots = ({ sharedRoot, otherWorktrees }: Pick<WorktreeGuardContext, "sharedRoot" | "otherWorktrees">): string[] => [sharedRoot, ...(otherWorktrees ?? [])];

/** Expansion syntax the guard cannot resolve statically. */
const hasExpansion = (value: string) => /[$`]/.test(value);

/** A git command that cannot be shown to target the session's own worktree. */
export const isolated = (worktreePath: string, problem: GitTargetProblem): WorktreeGuardRefusal => ({ kind: "gitTarget", worktreePath, problem });

/**
 * Whether a shell command may run git, so its targets need the repository's
 * worktree list: any spelling the parse resolves to git (`g"it"`, `\\git`,
 * `$'\\x67it'`, `env git`), git passed to a runner, git in a script a shell
 * runs, or a line that does not parse. Over-matching costs one `git worktree list`.
 */
export function namesGit(command: string): boolean {
	if (mentionsGit(command)) return true;
	const { segments, parseFailed } = parseCommand(command);
	if (parseFailed) return true;
	return segments.some((seg) => {
		const { command: cmd, args } = resolvePayload(leadTokens(seg));
		return cmd === "git" || args.some((arg) => arg.value === "git" || mentionsGit(arg.value));
	});
}

/** The worktree list could not be read, so a git command's target cannot be checked: refuse it. */
export const unlistedWorktreesReason = (worktreePath: string): WorktreeGuardRefusal => isolated(worktreePath, { kind: "unlisted" });

const stash = (risk: StashRisk, command: string): WorktreeGuardRefusal => ({ kind: "stash", risk, command });

export function stashReason(rest: Pick<Token, "value">[]): WorktreeGuardRefusal | undefined {
	const words = rest.map((t) => t.value);
	const sub = words.find((w) => !w.startsWith("-"));
	// `-m` may ride in a short-flag bundle (`git stash push -um wip`).
	const tagged = words.some(
		(w) => (/^-[a-zA-Z]+$/.test(w) && w.includes("m")) || w === "--message" || w.startsWith("--message="),
	);
	if (sub === undefined || sub === "push" || sub === "save") {
		if (tagged) return undefined;
		return stash("untagged", sub ? `git stash ${sub}` : "git stash");
	}
	if (sub === "pop") {
		return stash("pop", "git stash pop");
	}
	if (sub === "clear") {
		return stash("clear", "git stash clear");
	}
	if (sub === "drop") {
		const ref = words.slice(words.indexOf("drop") + 1).find((w) => !w.startsWith("-"));
		if (!ref) {
			return stash("drop", "git stash drop");
		}
	}
	if (sub === "branch") {
		// `git stash branch <name> [<stash>]`: without the stash ref it pops stash@{0}.
		const operands = words.slice(words.indexOf("branch") + 1).filter((w) => !w.startsWith("-"));
		if (operands.length < 2) {
			return stash("branch", "git stash branch");
		}
	}
	return undefined;
}

/** Environment variables that point git at a repository, like `--git-dir` and `--work-tree`. */
const GIT_REPOSITORY_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/;

/** `declare -x` / `typeset -gx`: the builtins that export like `export`. */
const exportsLikeExport = (cmd: string, args: Token[]) =>
	cmd === "export" || ((cmd === "declare" || cmd === "typeset") && args.some((arg) => /^-[a-zA-Z]*x/.test(arg.value)));

export function worktreeBashGuardReason(context: WorktreeGuardContext): WorktreeGuardRefusal | undefined {
	return guardScript(context.command, context.worktreePath, sharedRepositoryRoots(context), context.worktreePath, 0).reason;
}

/**
 * Judge one script that starts in `startDir` (undefined: not statically
 * known). Returns the refusal, if any, and whether the script can change the
 * directory of the shell it runs in (what an `eval` of it would do).
 */
/** Builtins that run a script in this shell. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(["eval", "source", "."]);

/** Shell options that take the next word as their value. */
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/**
 * The command lines a shell invocation runs: with `-c` (alone or in a cluster
 * such as `-lc`), the first operand; the words after it are `$0`, `$1`, …
 * (`bash -c 'echo ok' 'git status'` runs no git), unless the script expands
 * them (`bash -c '"$@"' _ git status`), when they are a command line too.
 * Without `-c`, every argument, since which one is a script file is not known.
 */
function shellScripts(args: Token[]): string[] {
	let command = false;
	let i = 0;
	for (; i < args.length; i++) {
		const value = args[i].value;
		if (value === "--" || value === "-") {
			i++;
			break;
		}
		if (!/^[-+]/.test(value)) break;
		if (SHELL_VALUE_OPTIONS.has(value)) i++;
		else if (/^-[A-Za-z]+$/.test(value) && value.includes("c")) command = true;
	}
	const values = args.map((arg) => arg.value);
	if (!command) return values;
	const [script, ...positional] = values.slice(i);
	if (script === undefined) return [];
	// `$0`…`$9`, `$@`, `$*`, `${1}`, `${@}`: read both from `$0` and from `$1`.
	if (!/\$(?:[0-9@*]|\{[0-9@*])/.test(script) || positional.length === 0) return [script];
	return [script, positional.join(" "), positional.slice(1).join(" ")];
}

/** Whether git appears as a word in `text`, read with quotes and backslashes removed (`gi\t`, `g"it"`). */
const mentionsGit = (text: string): boolean => /\bgit\b/.test(text.replace(/[\\'"]/g, ""));

/**
 * A script the guard cannot follow (it failed to parse, or is nested too deep):
 * refused if git appears anywhere in it, and a `cd` in it leaves the directory
 * unknown.
 */
function unverifiedScript(command: string, worktreePath: string, mayMove: boolean): { reason?: WorktreeGuardRefusal; moves?: boolean } {
	if (!mentionsGit(command)) return { moves: mayMove && /\b(?:cd|pushd|popd)\b/.test(command) };
	return { reason: isolated(worktreePath, { kind: "tooComplex" }) };
}

/** How many directories a segment may run in before the guard treats its directory as unknown. */
const MAX_POSSIBLE_DIRS = 8;

function guardScript(
	command: string,
	worktreePath: string,
	sharedRoots: readonly string[],
	startDir: string | undefined,
	depth: number,
): { reason?: WorktreeGuardRefusal; moves?: boolean } {
	const { segments, parseFailed } = parseCommand(command);
	if (parseFailed || segments.length === 0) return unverifiedScript(command, worktreePath, parseFailed);

	// Claude Code has one refusal for both stdin mechanisms (the profile words it).
	const stdinFed = () => isolated(worktreePath, { kind: "stdinFed" });

	/** Directory the current segment runs in; undefined = not statically known. */
	let dir: string | undefined = startDir;
	/**
	 * Repository variables an earlier `export` in this line set, by name:
	 * the directory they name, or undefined when it is not statically known.
	 * Later git in the line runs with them. Subshell scopes are ignored, which
	 * can only refuse more.
	 */
	const exportedGitEnv = new Map<string, string | undefined>();
	const envTarget = (value: string, token: Token | undefined): string | undefined =>
		!value || hasExpansion(value) || token?.dynamic || token?.glob || dir === undefined ? undefined : toAbsoluteBash(dir, value, homedir());
	/**
	 * The directories a segment may run in, per subshell scope
	 * (`Segment.scopes`): a `cd` inside `( … )`, a substitution or a pipeline
	 * member does not leak out. A `cd` that may not run (`false && cd x`, an
	 * `if` branch) leaves both the old and the new directory possible, and every
	 * git command must be safe in each.
	 */
	const scopeDirs = scopedTracker<(string | undefined)[]>([startDir]);

	// A git command as the parse sees it, spelled any way (`gi\t`, `env git`,
	// `xargs git`, `parallel git`), or anywhere in the script a shell or `eval`
	// runs (`bash -c '…'`), read as text with quotes and backslashes removed so
	// a script too complex to parse still counts.
	const runsGit = (seg: (typeof segments)[number]) => {
		const { command: cmd, args } = resolvePayload(leadTokens(seg));
		if (cmd === "git" || (cmd === "parallel" && args.some((arg) => arg.value === "git"))) return true;
		if (!INLINE_SCRIPT_SHELLS.has(cmd) && !SCRIPT_RUNNERS.has(cmd)) return false;
		return args.some((arg) => mentionsGit(arg.value));
	};
	// A loop body runs more than once, so a `cd` in it moves every git command
	// in the loop after the first pass; the segments show one pass only.
	// An `eval` there may `cd` too.
	const movesOrEvals = (seg: (typeof segments)[number]) => movesDirectory(seg) || resolvePayload(leadTokens(seg)).command === "eval";
	const movesInLoop = segments.some((seg) => seg.enclosing.some((construct) => LOOPS.has(construct)) && movesOrEvals(seg));
	if (movesInLoop && segments.some(runsGit)) {
		return { reason: isolated(worktreePath, { kind: "cdInLoop" }) };
	}
	// The last member of a pipeline runs in the current shell under `shopt -s
	// lastpipe`, so its `cd` may move every later command.
	// Only a git command after such a `cd` can be moved by it.
	// Inside a substitution too (`$(echo | cd /repo; git status)`), but only for
	// git later in the shell that tail runs in.
	const inShell = (seg: (typeof segments)[number], shell: number[]) => shell.every((scope, depth) => seg.scopes[depth] === scope);
	const pipeMoved = segments.some(
		(cd, index) => cd.pipelineShell && movesDirectory(cd) && segments.slice(index + 1).some((seg) => inShell(seg, cd.pipelineShell!) && runsGit(seg)),
	);
	if (pipeMoved) {
		return { reason: isolated(worktreePath, { kind: "cdInPipeline" }) };
	}

	const checkSegment = (seg: (typeof segments)[number]): WorktreeGuardRefusal | undefined => {
		const tokens = leadTokens(seg);
		const rawLead = tokens[0]?.value;
		if (!rawLead) return undefined;
		// The command a wrapper runs (`builtin cd`, `command cd`), not the first word.
		const { command: lead, args: leadArgs } = resolvePayload(tokens);

		if (lead === "cd") {
			// Skip cd's own options (-P/-L/-e/-@); `--` ends them; a lone `-`
			// means the previous directory, which is not statically known.
			let j = 0;
			while (j < leadArgs.length && leadArgs[j].value.startsWith("-") && !["-", "--"].includes(leadArgs[j].value)) j++;
			if (leadArgs[j]?.value === "--") j++;
			const targetToken = leadArgs[j];
			const target = targetToken?.value;
			if (!target) dir = homedir();
			// A glob (`cd /r*po`), an expansion or `~user` lands wherever bash expands it.
			else if (hasExpansion(target) || target === "-" || targetToken.glob || targetToken.dynamic || isUnknownTilde(target)) dir = undefined;
			// An absolute (or ~) destination re-anchors the tracked directory
			// even when it was unknown — later git commands become checkable again.
			else if (isAbsolute(target) || target === "~" || target.startsWith("~/")) dir = toAbsoluteBash("/", target, homedir());
			else if (dir !== undefined) dir = toAbsoluteBash(dir, target, homedir());
			return undefined;
		}
		if (lead === "pushd" || lead === "popd") {
			dir = undefined;
			return undefined;
		}

		const { command: cmd, args, peeled } = resolvePayload(tokens);
		// Git behind a wrapper the strict reading does not peel (`sudo`, `exec`,
		// `env -C /repo`): the wrapper may have moved it, so its target cannot be
		// read off the command.
		// A shell, `eval` or `source` in command position is judged below instead.
		if (cmd !== "git" && !SCRIPT_RUNNERS.has(cmd) && !INLINE_SCRIPT_SHELLS.has(cmd)) {
			const wide = resolvePayload(tokens, "wide");
			const runsScript = INLINE_SCRIPT_SHELLS.has(wide.command) || SCRIPT_RUNNERS.has(wide.command);
			const shellScript = runsScript && wide.args.some((arg) => mentionsGit(arg.value));
			if (wide.command === "git" || shellScript || wide.scripts.some(mentionsGit)) {
				return isolated(worktreePath, { kind: "wrapper", wrapper: rawLead });
			}
		}

		// A script a shell or `eval` runs is judged as commands of its own,
		// starting where this command runs: `bash -c 'cd /repo && git status'`
		// runs git in /repo. A shell's script runs in a child, but `eval` runs
		// in this shell, so a `cd` in it moves the commands after it.
		// Past three levels a script is judged as one the guard cannot follow.
		if (INLINE_SCRIPT_SHELLS.has(cmd) || cmd === "eval") {
			const scripts = cmd === "eval" ? [args.map((arg) => arg.value).join(" ")] : shellScripts(args);
			for (const script of scripts) {
				const nested = depth < 3 ? guardScript(script, worktreePath, sharedRoots, dir, depth + 1) : unverifiedScript(script, worktreePath, true);
				if (nested.reason) return nested.reason;
				if (cmd === "eval" && nested.moves) dir = undefined;
			}
			return undefined;
		}

		// `source <(…)`, `. "$f"`: the script is only known at runtime, so git in
		// its source text cannot be checked.
		// It runs in this shell, so a `cd` in it would move later git: the
		// directory is unknown after it. A literal file (`source .venv/bin/activate`)
		// keeps it: its text is not the guard's to read.
		if ((cmd === "source" || cmd === ".") && args.some((arg) => arg.dynamic)) {
			const unverified = unverifiedScript(seg.raw, worktreePath, false);
			if (unverified.reason) return unverified.reason;
			dir = undefined;
		}

		// Git whose arguments are assembled at runtime — the repository it will
		// target cannot be read off the command.
		if (cmd === "git" && peeled.includes("xargs")) return stdinFed();
		if (rawLead === "parallel" && tokens.some((t) => t.value === "git")) return stdinFed();
		if (
			cmd === "find" &&
			args.some((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a.value)) &&
			args.some((a) => a.value === "git")
		) {
			return isolated(worktreePath, { kind: "findExec" });
		}

		if (exportsLikeExport(cmd, args)) {
			for (const arg of args) {
				const name = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)(=|$)/.exec(arg.value);
				if (!name) continue;
				// `export GIT_DIR` (no value) exports whatever it was set to earlier.
				exportedGitEnv.set(name[1], name[2] ? envTarget(arg.value.slice(name[0].length), arg) : undefined);
			}
			return undefined;
		}

		if (cmd !== "git") return undefined;

		if (dir === undefined) {
			return isolated(worktreePath, { kind: "precedingCd" });
		}

		// Effective repository target: the tracked cwd, adjusted by global flags.
		let effective = dir;
		const extraTargets: string[] = [];
		// `GIT_DIR=… git`, `env GIT_WORK_TREE=… git`, and an earlier `export`:
		// the environment spelling of `--git-dir` / `--work-tree`.
		const envRefusal = (name: string) => isolated(worktreePath, { kind: "runtimeEnv", name });
		const prefix = tokens.slice(0, tokens.length - args.length - 1);
		const assigned = new Map(exportedGitEnv);
		for (const token of prefix) {
			if (!GIT_REPOSITORY_ENV.test(token.value)) continue;
			const eq = token.value.indexOf("=");
			assigned.set(token.value.slice(0, eq), envTarget(token.value.slice(eq + 1), token));
		}
		for (const [name, target] of assigned) {
			if (target === undefined) return envRefusal(name);
			extraTargets.push(target);
		}
		let i = 0;
		while (i < args.length) {
			const value = args[i].value;
			if (!value.startsWith("-")) break;
			// `-c core.worktree=<dir>` is `--work-tree` spelled as config;
			// `--config-env` takes the value from a variable at runtime.
			if (value === "-c" && /^core\.worktree=/i.test(args[i + 1]?.value ?? "")) {
				const raw = args[i + 1].value.slice(args[i + 1].value.indexOf("=") + 1);
				if (!raw || hasExpansion(raw)) return envRefusal("core.worktree");
				extraTargets.push(toAbsoluteBash(effective, raw, homedir()));
				i += 2;
				continue;
			}
			if ((value === "--config-env" && /^core\.worktree=/i.test(args[i + 1]?.value ?? "")) || /^--config-env=core\.worktree=/i.test(value)) {
				return envRefusal("core.worktree");
			}
			const pathFlag = value === "-C" || value === "--git-dir" || value === "--work-tree";
			const inlined = value.startsWith("--git-dir=") || value.startsWith("--work-tree=");
			if (pathFlag || inlined) {
				const pathToken = inlined ? args[i] : args[i + 1];
				const raw = inlined ? value.slice(value.indexOf("=") + 1) : pathToken?.value;
				if (!raw || hasExpansion(raw) || pathToken?.dynamic || pathToken?.glob || isUnknownTilde(raw)) {
					return isolated(worktreePath, { kind: "runtimeFlag", flag: value });
				}
				const resolved = toAbsoluteBash(effective, raw, homedir());
				if (value === "-C") effective = resolved;
				else extraTargets.push(resolved);
				i += inlined ? 1 : 2;
				continue;
			}
			i += ["-c", "--namespace", "--exec-path", "--config-env"].includes(value) ? 2 : 1;
		}

		const targets = [effective, ...extraTargets];
		for (const target of targets) {
			if (containsPath(worktreePath, target)) continue;
			if (sharedRoots.some((root) => containsPath(root, target))) {
				return isolated(worktreePath, { kind: "sharedTarget", target });
			}
			// An unrelated repository elsewhere on disk — not this guard's concern.
		}

		// The stash stack is per-repository and shared across its worktrees. Any
		// shared-root target that is NOT inside the worktree already returned
		// above, so only worktree-contained targets can reach this check.
		if (targets.some((t) => containsPath(worktreePath, t))) {
			const { sub, rest } = gitSubcommand(args);
			if (sub === "stash") {
				const reason = stashReason(rest);
				if (reason) return reason;
			}
		}
		return undefined;
	};

	for (const seg of segments) {
		const before = scopeDirs.get(seg);
		const after: (string | undefined)[] = [];
		for (const start of before) {
			dir = start;
			const reason = checkSegment(seg);
			if (reason) return { reason };
			after.push(dir);
		}
		const possible = [...new Set(seg.conditional ? [...before, ...after] : after)];
		// Past a handful of possibilities the directory is as good as unknown.
		scopeDirs.set(seg, possible.length > MAX_POSSIBLE_DIRS ? [undefined] : possible);
	}
	return { moves: segments.some(movesDirectory) || segments.some((seg) => resolvePayload(leadTokens(seg)).command === "eval") };
}

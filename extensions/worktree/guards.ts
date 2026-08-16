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
 *    checkout or a sibling worktree (`git -C`, `--git-dir`, `--work-tree`, a
 *    preceding `cd`), is refused with the fix named. Git against an unrelated
 *    repository elsewhere on disk is left alone — the permission gate and
 *    auto-mode still apply to it.
 * 2. The stash stack is shared by the main checkout and every worktree of the
 *    repository, and parallel sessions can interleave on it. Stash forms that
 *    collide with a concurrent session (untagged push, `pop`, `clear`,
 *    ref-less `drop`) are refused with the tag + apply-by-SHA recipe.
 *
 * Steering, not security: only bash is inspected here, and an unparseable
 * command is refused only when it visibly involves git (fail closed on the
 * invariant, fail open on everything else).
 */

import { homedir } from "node:os";
import { isWithin, toAbsolute } from "../auto-mode/paths.ts";
import { gitSubcommand, leadTokens, parseCommand, resolvePayload, type Token } from "../auto-mode/shell-analysis.ts";

export interface WorktreeGuardContext {
	command: string;
	/** The isolated worktree this session works in. */
	worktreePath: string;
	/** Root of the shared checkout the worktree belongs to. */
	sharedRoot: string;
}

/** Expansion syntax the guard cannot resolve statically. */
const hasExpansion = (value: string) => /[$`]/.test(value);

const isolated = (worktreePath: string, problem: string, fix: string): string =>
	`This session is isolated in the worktree ${worktreePath}, but ${problem}. ` +
	`Refusing to run it — a worktree-isolated session's git operations must target its own worktree. ${fix}`;

function stashMessage(form: string, hazard: string): string {
	return (
		`Blocked: \`${form}\` — the git stash stack is shared between the main checkout and every worktree of this repository, and parallel sessions may push or pop entries concurrently; ${hazard}. ` +
		"Prefer a temporary WIP commit on this worktree's branch to set work aside. If you must stash: " +
		'`git stash push -u -m "<unique-tag>"`, capture your entry\'s SHA with `git stash list --format=\'%H %gs\'`, ' +
		"restore with `git stash apply <sha>` (not pop), and drop your entry only after re-finding it by tag."
	);
}

function stashReason(rest: Token[]): string | undefined {
	const words = rest.map((t) => t.value);
	const sub = words.find((w) => !w.startsWith("-"));
	// `-m` may ride in a short-flag bundle (`git stash push -um wip`).
	const tagged = words.some(
		(w) => (/^-[a-zA-Z]+$/.test(w) && w.includes("m")) || w === "--message" || w.startsWith("--message="),
	);
	if (sub === undefined || sub === "push" || sub === "save") {
		if (tagged) return undefined;
		return stashMessage(
			sub ? `git stash ${sub}` : "git stash",
			"an untagged entry cannot be reliably re-found once other sessions push their own",
		);
	}
	if (sub === "pop") {
		return stashMessage("git stash pop", "`pop` resolves stash indexes at apply time, so it can grab or destroy another session's entry");
	}
	if (sub === "clear") {
		return stashMessage("git stash clear", "`clear` deletes every session's stashes, not just yours");
	}
	if (sub === "drop") {
		const ref = words.slice(words.indexOf("drop") + 1).find((w) => !w.startsWith("-"));
		if (!ref) {
			return stashMessage("git stash drop", "a ref-less `drop` deletes whatever is currently stash@{0}, which may be another session's entry");
		}
	}
	return undefined;
}

export function worktreeBashGuardReason({ command, worktreePath, sharedRoot }: WorktreeGuardContext): string | undefined {
	const { segments, parseFailed } = parseCommand(command);
	if (parseFailed || segments.length === 0) {
		if (!/\bgit\b/.test(command)) return undefined;
		return isolated(
			worktreePath,
			"this command is too complex to verify that its git operations stay inside the worktree",
			`Break it into plain, separate git commands with literal paths and run them from ${worktreePath}.`,
		);
	}

	/** Directory later segments run in; undefined = not statically known. */
	let dir: string | undefined = worktreePath;
	/** Subshell nesting: a `cd` inside `(...)` must not leak past the `)`. */
	let depth = 0;
	let dirBeforeSubshell: { dir: string | undefined } | undefined;

	const checkSegment = (seg: (typeof segments)[number]): string | undefined => {
		const tokens = leadTokens(seg);
		const rawLead = tokens[0]?.value;
		if (!rawLead) return undefined;

		if (rawLead === "cd") {
			// Skip cd's own options (-P/-L/-e/-@); `--` ends them; a lone `-`
			// means the previous directory, which is not statically known.
			let j = 1;
			while (j < tokens.length && tokens[j].value.startsWith("-") && !["-", "--"].includes(tokens[j].value)) j++;
			if (tokens[j]?.value === "--") j++;
			const target = tokens[j]?.value;
			if (!target) dir = homedir();
			else if (hasExpansion(target) || target === "-") dir = undefined;
			// An absolute (or ~) destination re-anchors the tracked directory
			// even when it was unknown — later git commands become checkable again.
			else if (target.startsWith("/") || target === "~" || target.startsWith("~/")) dir = toAbsolute("/", target, homedir());
			else if (dir !== undefined) dir = toAbsolute(dir, target, homedir());
			return undefined;
		}
		if (rawLead === "pushd" || rawLead === "popd") {
			dir = undefined;
			return undefined;
		}

		const { command: cmd, args, peeled } = resolvePayload(tokens);

		// Git whose arguments are assembled at runtime — the repository it will
		// target cannot be read off the command.
		if (cmd === "git" && peeled.includes("xargs")) {
			return isolated(
				worktreePath,
				"this command feeds git its arguments from stdin at runtime (xargs), so the repository it targets cannot be verified",
				"Run the git commands directly, with explicit literal paths, instead of assembling them at runtime.",
			);
		}
		if (rawLead === "parallel" && tokens.some((t) => t.value === "git")) {
			return isolated(
				worktreePath,
				"this command feeds git its arguments from stdin at runtime (parallel), so the repository it targets cannot be verified",
				"Run the git commands directly, with explicit literal paths, instead of assembling them at runtime.",
			);
		}
		if (
			cmd === "find" &&
			args.some((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a.value)) &&
			args.some((a) => a.value === "git")
		) {
			return isolated(
				worktreePath,
				"this command assembles git invocations at runtime (find -exec), so the repositories they target cannot be verified",
				"Run the git commands directly, with explicit literal paths, instead of assembling them at runtime.",
			);
		}

		if (cmd !== "git") return undefined;

		if (dir === undefined) {
			return isolated(
				worktreePath,
				"a preceding directory change makes the repository this git command targets unverifiable",
				`Use literal paths inside ${worktreePath} instead.`,
			);
		}

		// Effective repository target: the tracked cwd, adjusted by global flags.
		let effective = dir;
		const extraTargets: string[] = [];
		let i = 0;
		while (i < args.length) {
			const value = args[i].value;
			if (!value.startsWith("-")) break;
			const pathFlag = value === "-C" || value === "--git-dir" || value === "--work-tree";
			const inlined = value.startsWith("--git-dir=") || value.startsWith("--work-tree=");
			if (pathFlag || inlined) {
				const raw = inlined ? value.slice(value.indexOf("=") + 1) : args[i + 1]?.value;
				if (!raw || hasExpansion(raw)) {
					return isolated(
						worktreePath,
						`\`git ${value}\` computes its repository target at runtime, so it cannot be verified`,
						`Use literal paths inside ${worktreePath} instead.`,
					);
				}
				const resolved = toAbsolute(effective, raw, homedir());
				if (value === "-C") effective = resolved;
				else extraTargets.push(resolved);
				i += inlined ? 1 : 2;
				continue;
			}
			i += ["-c", "--namespace", "--exec-path", "--config-env"].includes(value) ? 2 : 1;
		}

		const targets = [effective, ...extraTargets];
		for (const target of targets) {
			if (isWithin(worktreePath, target)) continue;
			if (isWithin(sharedRoot, target)) {
				return isolated(
					worktreePath,
					`this git command targets ${target}, which is the shared checkout or another worktree of the same repository`,
					`Run the equivalent against ${worktreePath}.`,
				);
			}
			// An unrelated repository elsewhere on disk — not this guard's concern.
		}

		// The stash stack is per-repository and shared across its worktrees. Any
		// shared-root target that is NOT inside the worktree already returned
		// above, so only worktree-contained targets can reach this check.
		if (targets.some((t) => isWithin(worktreePath, t))) {
			const { sub, rest } = gitSubcommand(args);
			if (sub === "stash") {
				const reason = stashReason(rest);
				if (reason) return reason;
			}
		}
		return undefined;
	};

	for (const seg of segments) {
		// Subshell bookkeeping reads the RAW tokens — leadTokens strips the very
		// parens being counted. A `cd` between `(` and `)` is scoped: the tracked
		// directory is restored when the subshell closes.
		const first = seg.tokens[0]?.value ?? "";
		const opens = (/^\(+/.exec(first)?.[0] ?? "").length;
		if (opens > 0 && depth === 0) dirBeforeSubshell = { dir };
		depth += opens;

		const reason = checkSegment(seg);
		if (reason) return reason;

		const last = seg.tokens[seg.tokens.length - 1]?.value ?? "";
		const closes = (/\)+$/.exec(last)?.[0] ?? "").length;
		if (closes > 0 && depth > 0) {
			depth = Math.max(0, depth - closes);
			if (depth === 0 && dirBeforeSubshell) {
				dir = dirBeforeSubshell.dir;
				dirBeforeSubshell = undefined;
			}
		}
	}
	return undefined;
}

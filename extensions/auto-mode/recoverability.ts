/**
 * Git-recoverability check for the containment pre-gate (pure core + thin git
 * runner).
 *
 * ## Why this exists
 *
 * Claude Code's auto mode trusts the whole project directory as the agent's
 * sandbox: an in-project `rm` or `git reset --hard` is auto-approved with no
 * classifier call, even when it destroys uncommitted or untracked work git can
 * never restore (confirmed live — see docs/decisions/auto-mode.md). One Code
 * keeps the cheap in-project fast path but refuses that specific risk: an
 * in-project destructive action is auto-approved **only when git can put the
 * bytes back** — the target is tracked and clean (whole-tree ops: the entire
 * tree is clean). Anything else — untracked, dirty, not a git repo, or a git
 * query we could not run — is `unknown`/`unrecoverable`, and the pre-gate
 * escalates it to the classifier rather than destroying it silently.
 *
 * ## Contract
 *
 * Like the shell pre-gate, this may only ever *widen* what is provably safe.
 * `recoverable` is returned only on positive proof (git says tracked+clean);
 * every ambiguity — an error, a path git does not know, a non-repo — resolves to
 * `unknown`, which the caller treats exactly like `unrecoverable`: classify.
 * Being wrong toward `unknown` costs a classifier call; being wrong toward
 * `recoverable` destroys the user's work, so uncertainty never lands there.
 */

import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";

export type Recoverability = "recoverable" | "unrecoverable" | "unknown";

export interface RecoverabilityResult {
	verdict: Recoverability;
	/** One line naming why, for the decision log — never echoes file contents. */
	reason: string;
}

/** What git reports about one destruction target. */
export interface TargetState {
	/** Original token, for the reason string (never an expanded value). */
	token: string;
	/** `git ls-files` matched it — git has a committed/indexed copy to restore from. */
	tracked: boolean;
	/** `git status --porcelain` reported anything for it — uncommitted state that a restore would not bring back. */
	dirty: boolean;
}

/**
 * Judge a set of explicit destruction targets (`rm a b`, `truncate f`). Every
 * target must be independently recoverable; the first that is not decides the
 * whole action, since one command destroys them all.
 */
export function judgeTargets(targets: TargetState[]): RecoverabilityResult {
	if (targets.length === 0) return { verdict: "unknown", reason: "no destruction target could be identified" };
	for (const target of targets) {
		if (!target.tracked) {
			return { verdict: "unrecoverable", reason: `${target.token} is not tracked by git, so deleting it is not reversible` };
		}
		if (target.dirty) {
			return {
				verdict: "unrecoverable",
				reason: `${target.token} has uncommitted changes that a git restore would not bring back`,
			};
		}
	}
	return { verdict: "recoverable", reason: "every target is tracked by git and clean, so git can restore it" };
}

/**
 * Judge a whole-tree destructive op. Recoverable only when the entire working
 * tree is clean: a clean tree's state is committed (reachable again via
 * reflog/checkout), while any modified, staged, or untracked entry is content the
 * op would erase for good. This judge is generic over any tree-wide reset, but at
 * present only `git reset --hard` is routed here — `git clean -fd` / `git checkout
 * .` are escalated directly by shell-analysis (isWholeTreeGitReset), so they reach
 * the classifier rather than this fast path.
 */
export function judgeWholeTree(isRepo: boolean, statusPorcelain: string): RecoverabilityResult {
	if (!isRepo) return { verdict: "unrecoverable", reason: "not a git repository, so a tree-wide reset cannot be undone" };
	return statusPorcelain.trim().length === 0
		? { verdict: "recoverable", reason: "the working tree is clean, so git can restore it" }
		: { verdict: "unrecoverable", reason: "the working tree has uncommitted or untracked changes a reset would destroy" };
}

/** Combine several sub-verdicts: the whole action is only as recoverable as its least-recoverable part. */
export function combine(results: RecoverabilityResult[]): RecoverabilityResult {
	if (results.length === 0) return { verdict: "unknown", reason: "nothing to check" };
	const worst = results.find((r) => r.verdict === "unrecoverable") ?? results.find((r) => r.verdict === "unknown");
	return worst ?? results[0];
}

/** A thin, defensive git call: any failure (not a repo, git missing, timeout) becomes `undefined`. */
function git(cwd: string, args: string[]): { ok: boolean; stdout: string } | undefined {
	try {
		const stdout = execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
		return { ok: true, stdout };
	} catch (error) {
		// A non-zero exit still carries stdout (e.g. ls-files --error-unmatch), which
		// the caller may want; distinguish "ran and said no" from "could not run".
		const status = (error as { status?: number }).status;
		if (typeof status === "number") return { ok: false, stdout: String((error as { stdout?: unknown }).stdout ?? "") };
		return undefined; // git not found / timed out / killed — genuinely unknown
	}
}

export interface Destruction {
	/** Resolved absolute paths the command destroys (already proven in-project by the pre-gate). */
	targets: string[];
	/** True for reset --hard / clean / checkout . — the target is the whole working tree, not named paths. */
	wholeTree: boolean;
}

/**
 * Run the git queries and judge. `cwd` is the command's effective directory.
 * Returns `unknown` on any git failure so the caller escalates rather than
 * trusting an answer we could not compute.
 */
export function checkRecoverability(cwd: string, destruction: Destruction): RecoverabilityResult {
	const repoProbe = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	const isRepo = repoProbe?.ok === true && repoProbe.stdout.trim() === "true";

	if (destruction.wholeTree) {
		if (!isRepo) return judgeWholeTree(false, "");
		const status = git(cwd, ["status", "--porcelain"]);
		if (!status) return { verdict: "unknown", reason: "could not read git status to judge a tree-wide reset" };
		return judgeWholeTree(true, status.stdout);
	}

	if (destruction.targets.length === 0) return { verdict: "unknown", reason: "no destruction target could be identified" };
	if (!isRepo) return { verdict: "unrecoverable", reason: "not a git repository, so deletion is not reversible" };

	const states: TargetState[] = [];
	for (const path of destruction.targets) {
		// A target that does not exist has nothing to lose: deleting it is a no-op,
		// truncating it creates a fresh empty file. Either way there is no
		// pre-existing content a restore would need to bring back. Use lstat, not
		// existsSync: existsSync follows a symlink to its target, so a tracked-but-
		// dirty *broken* symlink (its target missing) would read as "nothing to
		// lose" and be wrongly cleared as recoverable — the link entry itself is
		// real, uncommitted content, so it must be queried against git.
		let entryExists = true;
		try {
			lstatSync(path);
		} catch {
			entryExists = false;
		}
		if (!entryExists) continue;
		const tracked = git(cwd, ["ls-files", "--error-unmatch", "--", path]);
		const status = git(cwd, ["status", "--porcelain", "--", path]);
		if (tracked === undefined || status === undefined) {
			return { verdict: "unknown", reason: "could not query git for a deletion target" };
		}
		states.push({ token: path, tracked: tracked.ok, dirty: status.stdout.trim().length > 0 });
	}
	// Every target was a non-existent path (pure creation / no-op) — nothing to lose.
	if (states.length === 0) return { verdict: "recoverable", reason: "no existing content would be destroyed" };
	return judgeTargets(states);
}

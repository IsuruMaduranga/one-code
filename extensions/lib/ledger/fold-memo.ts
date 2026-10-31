/**
 * One fold per branch state: the extensions that read the ledger's fold
 * (the ledger's `context` hook, its payload hook, tool-search, claude-context)
 * share the last fold of each session instead of folding the same branch
 * again. `foldBranch` is O(requests × list length), and tool-search folds at
 * every `turn_start`, moments before the ledger's `context` hook folds the
 * same branch for the request (in every child session too).
 *
 * The memo lives in process state (lib/process-state.ts), since each
 * extension file evaluates its own copy of this module (findings §3), keyed
 * by the session manager. A hit needs the same identity and the same entries
 * (every entry the same object, in the same order): any appended entry, a
 * different leaf or a rebuilt branch misses, so it never returns another
 * branch's fold. The fold is a pure function of the two, and its readers
 * never mutate it.
 *
 * Pure: no pi imports.
 */
import { processState } from "../process-state.ts";
import { foldBranch, type LedgerFold } from "./fold.ts";
import type { EntryLike, RequestIdentity } from "./records.ts";

interface Memo {
	/** A copy of the branch it folded: `getBranch()` may hand back a list that grows in place. */
	entries: readonly EntryLike[];
	identity: string;
	fold: LedgerFold;
}

const memos = () => processState("ledger:fold-memo", () => new WeakMap<object, Memo>());

/** Whether two branches hold the same entries, each the same object, in the same order: the key a memo of anything derived from a branch takes. */
export const sameEntries = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((entry, i) => entry === b[i]);

/** `foldBranch(branch, identity)`, reused while `owner`'s branch and the identity stay the same. Without an owner it folds. */
export function foldOnce(owner: object | undefined, branch: readonly EntryLike[], identity: RequestIdentity | undefined): LedgerFold {
	if (!owner) return foldBranch(branch, identity);
	const key = JSON.stringify(identity ?? null);
	const memo = memos().get(owner);
	if (memo && memo.identity === key && sameEntries(memo.entries, branch)) return memo.fold;
	const fold = foldBranch(branch, identity);
	memos().set(owner, { entries: [...branch], identity: key, fold });
	return fold;
}

/** The fold of a session's current branch under `identity` (`sessionIdentity`, lib/anthropic-auth.ts). */
export function foldSession(sessionManager: { getBranch(): unknown[] } | undefined, identity: RequestIdentity | undefined): LedgerFold {
	return foldOnce(sessionManager, (sessionManager?.getBranch() ?? []) as EntryLike[], identity);
}

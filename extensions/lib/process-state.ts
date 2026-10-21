/**
 * Process state: what lives as long as the One Code process and no longer
 * (lifecycle-grid-hunt plan, part D). Every piece of state an extension holds
 * is one of three kinds:
 *
 * - branch state follows the conversation: a resume, `/reload`, `/fork` and
 *   `/tree` each read it back from the branch (a `one-code:state` entry,
 *   lib/ledger/state.ts, or a fold of the branch's own entries);
 * - process state survives `/reload` and the session swaps of `/clear`,
 *   `/new`, `/resume` and `/fork`, and ends with the process (a grant the
 *   user gave "for this session", a notice owed to the next session): this
 *   module;
 * - resources (a timer, a child process, a connection) end with the instance
 *   that opened them, in `session_shutdown`.
 *
 * Module scope is none of them: pi re-evaluates every extension module at a
 * `/reload` and at a `/resume` into another directory (findings §8), so a
 * module-level value is lost there and kept everywhere else. The store here
 * is a `globalThis` slot, which no re-evaluation resets.
 *
 * Pure: no pi imports.
 */

const SLOT = Symbol.for("one-code:process-state");

type Store = Map<string, unknown>;

function store(): Store {
	const slot = globalThis as { [SLOT]?: Store };
	return (slot[SLOT] ??= new Map());
}

/**
 * The process's value for `key`, created by `init` on first use. Keys are
 * namespaced by their owner (`"permissions:grants"`); the value is shared by
 * every instance of that owner in the process, so it must be mutated, not
 * replaced, or set again with `setProcessState`.
 */
export function processState<T>(key: string, init: () => T): T {
	const values = store();
	if (!values.has(key)) values.set(key, init());
	return values.get(key) as T;
}

/** Replace the process's value for `key`. */
export function setProcessState<T>(key: string, value: T): void {
	store().set(key, value);
}

/** Forget every process value: a test's fresh process. */
export function resetProcessStateForTest(): void {
	store().clear();
}

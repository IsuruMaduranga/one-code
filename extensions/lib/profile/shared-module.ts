/**
 * A module evaluated once per process and shared through a `Symbol.for` slot.
 * pi gives every extension its own module cache (findings §3, "Extension
 * isolation"), so a module every extension imports is evaluated once per
 * extension; one that holds no state can instead be loaded on demand by the
 * first copy that needs it and kept on `globalThis` for the rest
 * (decisions/bi-fork.md, "The shipped profile is evaluated once per
 * process"). Under jiti `require` is the calling extension's own loader;
 * elsewhere (a script) Node's. The unit tests fill each slot from their own
 * module graph (test/setup.ts), since vitest's imports are not the ones used.
 *
 * Pure: no pi imports.
 */

import { createRequire } from "node:module";

/** The module at `absolutePath`, loaded by the first caller and shared under `key`. */
export function sharedModule<T>(key: string, absolutePath: string): T {
	const slot = globalThis as Record<symbol, unknown>;
	const symbol = Symbol.for(key);
	if (slot[symbol] === undefined) {
		const load = typeof require === "function" ? require : createRequire(absolutePath);
		slot[symbol] = load(absolutePath);
	}
	return slot[symbol] as T;
}

/** Test seam: the module the slot under `key` shares, from the test run's own import of it. */
export function shareModuleForTest(key: string, module: unknown): void {
	(globalThis as Record<symbol, unknown>)[Symbol.for(key)] = module;
}

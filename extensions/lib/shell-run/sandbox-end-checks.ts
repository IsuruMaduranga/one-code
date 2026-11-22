/**
 * What the Linux sandbox checks when a wrapped command ends, beside the
 * runtime's own cleanup. bubblewrap cannot deny a missing `commondir` or the
 * names that make a directory a bare repository without a stub that breaks
 * git (sandbox-settings `plantableCommondirs`, `bareRepositoryFiles`), so a
 * `commondir` that appeared while a command ran is removed when it ends, and
 * a directory that became a bare repository while it ran has its `HEAD` set
 * aside, which keeps what was written.
 *
 * Every step stands alone: one that fails is reported through `notice` and
 * the others still run, and nothing here throws, so the caller's own
 * bookkeeping for the run is never skipped. Pure apart from the injected
 * filesystem.
 */

import { join } from "node:path";

/** The filesystem and runtime operations the checks use. */
export interface EndCheckOps {
	/** The runtime's cleanup after one wrap (its mount points for missing paths). */
	cleanup(): void;
	/** The checkout's `commondir` paths that nothing is at, which the sandbox cannot deny. */
	plantableCommondirs(cwd: string): string[];
	looksLikeBareRepository(dir: string): boolean;
	exists(path: string): boolean;
	remove(path: string): void;
	rename(from: string, to: string): void;
}

/** Where a planted `HEAD` is moved to. */
export const SET_ASIDE_HEAD = "HEAD.set-aside-by-sandbox";

/**
 * The checks of each run, by the run's id. What a run observes when it starts
 * is its own and is used once, when it ends, so an end only undoes what
 * appeared between that run's start and its end: a bare repository the user
 * made between two commands is left alone. Runs that overlap each act on
 * what is there when they end, so whichever ends first after the planted
 * name appeared undoes it, and the other finds nothing left to undo.
 */
export interface EndChecks {
	/** The run `id` is about to start in `cwd`. */
	started(id: string, cwd: string): void;
	/** The run `id` ended. Never throws. */
	ended(id: string): void;
	/** The run `id` never started (its wrap failed): forget what it observed, undo nothing. */
	discard(id: string): void;
}

/** What one run found when it started. */
interface RunObservation {
	/** The `commondir` paths nothing was at. */
	commondirs: string[];
	/** The run's directory, when it was not a bare repository. */
	notBare?: string;
}

export function createEndChecks(ops: EndCheckOps, notice: (message: string) => void): EndChecks {
	const runs = new Map<string, RunObservation>();
	const attempt = (step: () => void, failed: (reason: string) => string) => {
		try {
			step();
		} catch (error) {
			// Gone again in the meantime: nothing is left to undo.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			try {
				notice(failed((error as Error).message ?? String(error)));
			} catch {
				// A notice that cannot be shown must not stop the remaining checks.
			}
		}
	};
	return {
		started(id, cwd) {
			const run: RunObservation = { commondirs: [] };
			runs.set(id, run);
			attempt(
				() => {
					run.commondirs = ops.plantableCommondirs(cwd);
				},
				(reason) => `The command sandbox could not list the git files to check in ${cwd} after the command (${reason}).`,
			);
			attempt(
				() => {
					if (!ops.looksLikeBareRepository(cwd)) run.notBare = cwd;
				},
				(reason) => `The command sandbox could not check whether ${cwd} is a git repository (${reason}).`,
			);
		},
		discard(id) {
			runs.delete(id);
		},
		ended(id) {
			attempt(
				() => ops.cleanup(),
				(reason) => `The command sandbox could not clean up after a command (${reason}).`,
			);
			// Consumed before anything is undone: a run's observations are used once.
			const run = runs.get(id);
			runs.delete(id);
			if (!run) return;
			for (const path of run.commondirs) {
				attempt(
					() => {
						if (ops.exists(path)) ops.remove(path);
					},
					(reason) => `The command sandbox could not remove ${path}, which a sandboxed command created to redirect git (${reason}). Remove it before running git there.`,
				);
			}
			const dir = run.notBare;
			if (dir !== undefined) {
				attempt(
					() => {
						if (!ops.looksLikeBareRepository(dir)) return;
						// Never onto an earlier set-aside file: a rename replaces its target.
						let target = join(dir, SET_ASIDE_HEAD);
						for (let n = 2; ops.exists(target); n++) target = join(dir, `${SET_ASIDE_HEAD}.${n}`);
						ops.rename(join(dir, "HEAD"), target);
					},
					(reason) => `The command sandbox could not set aside ${join(dir, "HEAD")}, which a sandboxed command created to make ${dir} a git repository (${reason}). Move it away before running git there.`,
				);
			}
		},
	};
}

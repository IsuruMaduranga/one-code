/**
 * What the Linux sandbox checks when a wrapped command ends, beside the
 * runtime's own cleanup. bubblewrap cannot deny a missing `commondir` or the
 * names that make a directory a bare repository without a stub that breaks
 * git (sandbox-settings `plantableCommondirs`, `bareRepositoryFiles`), so a
 * `commondir` that appeared while a command ran is removed when a command
 * ends, and a directory that became a bare repository has its `HEAD` set
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

export interface EndChecks {
	/** A command is about to start in `cwd`. */
	started(cwd: string): void;
	/** A wrapped command ended. Never throws. */
	ended(): void;
}

export function createEndChecks(ops: EndCheckOps, notice: (message: string) => void): EndChecks {
	const plantable = new Set<string>();
	const notBare = new Set<string>();
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
		started(cwd) {
			attempt(
				() => {
					for (const path of ops.plantableCommondirs(cwd)) plantable.add(path);
				},
				(reason) => `The command sandbox could not list the git files to check in ${cwd} after the command (${reason}).`,
			);
			attempt(
				() => {
					if (!ops.looksLikeBareRepository(cwd)) notBare.add(cwd);
				},
				(reason) => `The command sandbox could not check whether ${cwd} is a git repository (${reason}).`,
			);
		},
		ended() {
			attempt(
				() => ops.cleanup(),
				(reason) => `The command sandbox could not clean up after a command (${reason}).`,
			);
			for (const path of plantable) {
				attempt(
					() => {
						if (ops.exists(path)) ops.remove(path);
					},
					(reason) => `The command sandbox could not remove ${path}, which a sandboxed command created to redirect git (${reason}). Remove it before running git there.`,
				);
			}
			for (const dir of notBare) {
				attempt(
					() => {
						if (ops.looksLikeBareRepository(dir)) ops.rename(join(dir, "HEAD"), join(dir, SET_ASIDE_HEAD));
					},
					(reason) => `The command sandbox could not set aside ${join(dir, "HEAD")}, which a sandboxed command created to make ${dir} a git repository (${reason}). Move it away before running git there.`,
				);
			}
		},
	};
}

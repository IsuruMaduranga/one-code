/**
 * Worktree isolation for in-process agent runs (`isolation: "worktree"` on the
 * Agent tool and workflow `agent()` calls): a registry of the live isolation
 * worktrees, and the inline-extension guard that applies the same git-isolation
 * bash guard an `enter_worktree` session gets (extensions/worktree/guards.ts).
 *
 * The registry exists because the association can only resolve at call time:
 * these worktrees live in tmpdirs (not statically recognizable paths), and the
 * child loaders are cached and shared across runs with different cwds.
 * createWorktree/cleanupWorktree (subagents/worktree.ts) register and release
 * entries; reconstructed run records re-register kept worktrees after a
 * process restart (subagents/index.ts); the guard resolves each bash call's
 * cwd against them.
 *
 * Module state is deliberate and safe despite jiti isolation: registration
 * (worktree creation) and lookup (the guard factory) always happen inside the
 * SAME extension's import graph — the subagents extension, or the workflow
 * extension via its own module copy — so the state never needs to cross
 * extensions.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { isWithin } from "../auto-mode/paths.ts";
import { worktreeBashGuardReason } from "../worktree/guards.ts";

export interface WorktreeIsolation {
	/** The isolated worktree the run works in. */
	worktreePath: string;
	/** Root of the shared checkout the worktree belongs to. */
	sharedRoot: string;
}

/** worktreePath → sharedRoot for every live isolation worktree. */
const active = new Map<string, string>();

export function registerWorktreeIsolation(worktreePath: string, sharedRoot: string): void {
	active.set(worktreePath, sharedRoot);
}

export function releaseWorktreeIsolation(worktreePath: string): void {
	active.delete(worktreePath);
}

/** The registered isolation worktree `cwd` lives in, if any. */
export function worktreeIsolationFor(cwd: string): WorktreeIsolation | undefined {
	for (const [worktreePath, sharedRoot] of active) {
		if (isWithin(worktreePath, cwd)) return { worktreePath, sharedRoot };
	}
	return undefined;
}

/**
 * The git-isolation bash guard for worktree-isolated child sessions, as its
 * own inline extension so it loads AHEAD of the permission gate — the same
 * guard-before-permissions layering the main session gets from extension load
 * order (worktree before permissions, findings §3). buildAgentLoader places it
 * first in `extensionFactories`; keep it there.
 */
export function worktreeGuardFactory(cwd: string): InlineExtension {
	return {
		name: "agent-worktree-guard",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", (event, ctx) => {
				if (event.toolName !== "bash") return undefined;
				const isolation = worktreeIsolationFor(ctx?.cwd ?? cwd);
				const command = (event.input as Record<string, unknown> | undefined)?.command;
				if (!isolation || typeof command !== "string") return undefined;
				const reason = worktreeBashGuardReason({
					command,
					worktreePath: isolation.worktreePath,
					sharedRoot: isolation.sharedRoot,
				});
				return reason ? { block: true, reason } : undefined;
			});
		},
	};
}

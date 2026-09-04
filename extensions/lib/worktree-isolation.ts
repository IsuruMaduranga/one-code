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

import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { isWithin, isWritingTool, pathArgument, resolveForContainment, toAbsolute } from "../auto-mode/paths.ts";
import { analyzeShellCommand } from "../auto-mode/shell-analysis.ts";
import { worktreeBashGuardReason } from "../worktree/guards.ts";

export interface WorktreeIsolation {
	/** The isolated worktree the run works in. */
	worktreePath: string;
	/** Root of the shared checkout the worktree belongs to. */
	sharedRoot: string;
	/**
	 * Both roots in resolved form (macOS /var → /private/var, symlinked
	 * checkouts), computed once at registration so the per-call write guard
	 * resolves only the write's own target, not two static roots per tool call.
	 */
	resolvedWorktreePath: string;
	resolvedSharedRoot: string;
}

/** Build the registry entry for a worktree, resolving both roots once. Exported for tests. */
export function describeIsolation(worktreePath: string, sharedRoot: string): WorktreeIsolation {
	return {
		worktreePath,
		sharedRoot,
		resolvedWorktreePath: resolveForContainment(worktreePath) ?? worktreePath,
		resolvedSharedRoot: resolveForContainment(sharedRoot) ?? sharedRoot,
	};
}

/** worktreePath → its isolation record, for every live isolation worktree. */
const active = new Map<string, WorktreeIsolation>();

export function registerWorktreeIsolation(worktreePath: string, sharedRoot: string): void {
	active.set(worktreePath, describeIsolation(worktreePath, sharedRoot));
}

export function releaseWorktreeIsolation(worktreePath: string): void {
	active.delete(worktreePath);
}

/** The registered isolation worktree `cwd` lives in, if any. */
export function worktreeIsolationFor(cwd: string): WorktreeIsolation | undefined {
	for (const isolation of active.values()) {
		if (isWithin(isolation.worktreePath, cwd)) return isolation;
	}
	return undefined;
}

/**
 * Where a write from an isolated run must not land: inside the shared checkout,
 * outside the worktree. Returns the corresponding worktree path when `target`
 * is such a path, else undefined (inside the worktree, or outside the
 * repository altogether — the permission gate still judges those). Shared by
 * the file-tool guard and the bash write-target guard below. Pure.
 */
export function sharedCheckoutWriteTarget(target: string, cwd: string, isolation: WorktreeIsolation, home = homedir()): string | undefined {
	const { worktreePath, sharedRoot, resolvedWorktreePath, resolvedSharedRoot } = isolation;
	const absolute = toAbsolute(cwd, target, home);
	// Fast path: spelled under the worktree as registered — the common case for
	// every write the model does where it was told to (no syscall).
	if (isWithin(worktreePath, absolute)) return undefined;
	// Resolved so a write is judged by where it lands, not how it is spelled.
	const resolved = resolveForContainment(absolute) ?? absolute;
	if (isWithin(resolvedWorktreePath, resolved) || !isWithin(resolvedSharedRoot, resolved)) return undefined;
	// The tail keeps the model's spelling when the path was written under the
	// shared root as given; the resolved forms are case-folded on darwin, which
	// would send the model to `a.ts` for a file named `A.ts` on a case-sensitive volume.
	const spelled = relative(sharedRoot, absolute);
	const tail = spelled && !spelled.startsWith("..") && !isAbsolute(spelled) ? spelled : relative(resolvedSharedRoot, resolved);
	return join(worktreePath, tail);
}

const refusal = (isolation: WorktreeIsolation, what: string, mapped: string): string =>
	`This agent is isolated in the worktree ${isolation.worktreePath}, but ${what} is in the shared checkout ${isolation.sharedRoot}. ` +
	`Refusing the write — an isolated agent's changes belong in its own worktree. Write the corresponding path there instead: ${mapped}`;

/**
 * Refuse a file-tool write (`edit`/`write`/`notebook_edit`) from an isolated
 * run that lands in the shared checkout: the model was told to work in the
 * worktree, but a fork inherits a transcript whose every path points at the
 * main tree, and a named agent's task may quote such paths too. Pure; exported
 * for tests.
 */
export function worktreeWriteGuardReason(input: {
	toolName: string;
	target: string | undefined;
	cwd: string;
	isolation: WorktreeIsolation;
	home?: string;
}): string | undefined {
	if (!isWritingTool(input.toolName) || !input.target) return undefined;
	const mapped = sharedCheckoutWriteTarget(input.target, input.cwd, input.isolation, input.home);
	return mapped ? refusal(input.isolation, input.target, mapped) : undefined;
}

/**
 * The same rule for a shell command: every path the command may write
 * (redirections, `sed -i`/`cp`/`mv`/`tee` positionals, output flags — the
 * write-target model auto-mode's shell analysis already maintains) is checked
 * like a file-tool target. Reads of the shared checkout stay allowed: the fork
 * may need to look at what it inherited. Interpreters (`sed -i`, `perl`,
 * `python`) are not modelled as writers there, so a write hidden in one reaches
 * the permission gate and, in auto mode, the classifier instead — steering, not
 * a sandbox (same contract as extensions/worktree/guards.ts). Pure; exported for tests.
 */
export function worktreeBashWriteGuardReason(input: { command: string; cwd: string; isolation: WorktreeIsolation; home?: string }): string | undefined {
	const home = input.home ?? homedir();
	const evidence = analyzeShellCommand({ command: input.command, cwd: input.cwd, home });
	for (const write of evidence.writes) {
		const mapped = sharedCheckoutWriteTarget(write.token, input.cwd, input.isolation, home);
		if (mapped) return refusal(input.isolation, `this command writes to ${write.token}, which`, mapped);
	}
	return undefined;
}

/**
 * The git-isolation guard for worktree-isolated child sessions, as its own
 * inline extension so it loads AHEAD of the permission gate — the same
 * guard-before-permissions layering the main session gets from extension load
 * order (worktree before permissions, findings §3). buildAgentLoader places it
 * first in `extensionFactories`; keep it there. Three checks: bash git operations
 * must target the worktree (extensions/worktree/guards.ts), and writes — by file
 * tool or by shell command — must land in it.
 */
export function worktreeGuardFactory(cwd: string): InlineExtension {
	return {
		name: "agent-worktree-guard",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", (event, ctx) => {
				const runCwd = ctx?.cwd ?? cwd;
				const isolation = worktreeIsolationFor(runCwd);
				if (!isolation) return undefined;
				const input = (event.input ?? {}) as Record<string, unknown>;
				if (event.toolName === "bash") {
					if (typeof input.command !== "string") return undefined;
					const reason =
						worktreeBashGuardReason({ command: input.command, worktreePath: isolation.worktreePath, sharedRoot: isolation.sharedRoot }) ??
						worktreeBashWriteGuardReason({ command: input.command, cwd: runCwd, isolation });
					return reason ? { block: true, reason } : undefined;
				}
				const reason = worktreeWriteGuardReason({ toolName: event.toolName, target: pathArgument(input), cwd: runCwd, isolation });
				return reason ? { block: true, reason } : undefined;
			});
		},
	};
}

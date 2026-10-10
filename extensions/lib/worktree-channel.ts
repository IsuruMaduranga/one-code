/**
 * The worktree session, announced over `pi.events` so other extensions can
 * follow it without sharing module state (jiti isolation, findings §3). The
 * worktree extension emits on every state change — enter, exit, and the
 * session_start/session_tree restore; the footer shows the worktree's path
 * and branch in place of the process cwd while one is active (Claude Code's
 * footer does the same), cron fires and monitors run there, and subagents
 * and workflow agents are spawned there (`sessionWorkCwd`). The bus does not
 * replay: a late subscriber sees the next change, which is fine here — every
 * subscriber subscribes at load, and the first emit is the session_start
 * restore.
 */

export const WORKTREE_CHANNEL = "one-code:worktree";

/** Payload: the active worktree, or null when the session left it. */
export interface WorktreeLocation {
	path: string;
	branch?: string;
	/** Root of the shared checkout the worktree belongs to, for the child sessions' git-isolation guard. */
	sharedRoot?: string;
}

/**
 * Where the session's work happens: the entered worktree while one is active,
 * else the session's own cwd. A removed worktree must fail at that path, never
 * silently redirect work into the original checkout. The worktree extension
 * announces a missing path on restore and blocks calls until an active missing
 * worktree is explicitly left. pi fixes a session's cwd at creation, so a child
 * spawned from `ctx.cwd` would work in the checkout the user meant to protect.
 */
export function sessionWorkCwd(entered: WorktreeLocation | null | undefined, sessionCwd: string): string {
	return entered?.path || sessionCwd;
}

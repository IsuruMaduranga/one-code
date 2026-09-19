/**
 * The worktree session, announced over `pi.events` so other extensions can
 * follow it without sharing module state (jiti isolation, findings §3). The
 * worktree extension emits on every state change — enter, exit, and the
 * session_start/session_tree restore; the footer shows the worktree's path
 * and branch in place of the process cwd while one is active (Claude Code's
 * footer does the same). The bus does not replay: a late subscriber sees the
 * next change, which is fine here — the footer subscribes at load, and the
 * first emit is the session_start restore.
 */

export const WORKTREE_CHANNEL = "one-code:worktree";

/** Payload: the active worktree, or null when the session left it. */
export interface WorktreeLocation {
	path: string;
	branch?: string;
}

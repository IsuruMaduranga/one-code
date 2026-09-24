/**
 * The workspace directories in force when a session starts, announced by the
 * permissions extension over `pi.events` (jiti isolation, findings §3) so the
 * system prompt can list them the way Claude Code's environment block does
 * (` - Additional working directories:`). It is emitted once, at
 * session_start: the system prompt stays byte-stable for the session, and a
 * directory added later reaches the model through the /permissions or
 * /add-dir command output instead.
 */

export const WORKSPACE_CHANNEL = "one-code:workspace-dirs";

export interface WorkspaceAnnouncement {
	/** Absolute, resolved paths, in the order the gate applies them. */
	dirs: string[];
}

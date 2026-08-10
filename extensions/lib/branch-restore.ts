/**
 * Shared "restore latest tool-result details from branch history" scan.
 *
 * Several extensions (todo, tasks, worktree) keep their live state in
 * tool-result `details`, so branching or resuming a session can rebuild it by
 * replaying `ctx.sessionManager.getBranch()`. Each one only wants the LAST
 * matching result that counts as a real state update — a failed or no-op call
 * (e.g. a refused exit_worktree) still produces a toolResult with the right
 * toolName, but its details must not clobber an earlier valid restore point.
 * `isValid` is exactly that per-site validity check.
 *
 * A forward loop that only overwrites its running value when `isValid` holds
 * is equivalent to "the last entry for which `isValid` holds wins" — entries
 * that fail the check are no-ops for the running value. So scanning backward
 * and returning at the first entry that passes `isValid` reproduces the same
 * result without walking the rest of the branch.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function restoreLatestDetails<T>(
	branch: SessionEntry[],
	toolNames: ReadonlySet<string>,
	isValid: (details: T | undefined) => boolean = (details) => details !== undefined,
): T | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || !toolNames.has(msg.toolName)) continue;
		const details = msg.details as T | undefined;
		if (isValid(details)) return details;
	}
	return undefined;
}

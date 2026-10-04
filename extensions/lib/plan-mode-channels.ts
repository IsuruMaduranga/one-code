/**
 * Bus channels between plan-mode and permissions, and the session entry that
 * records the plan file (also read by the post-compaction file restore). They
 * live here, not in either extension, because permissions cannot import
 * plan-mode (plan-mode already imports `permissions/modes.ts`) and a string
 * literal typed in two places is the one way a rename silently disconnects a
 * reader.
 */

/** Request a permission-mode change (`{ mode, toolCallId? }`); permissions applies it and anchors a tool-driven switch to its result. */
export const MODE_CHANNEL = "one-code:set-permission-mode";
/** Announces plan mode's one writable file (`{ path }`); the permissions matcher consumes it. */
export const PLAN_FILE_CHANNEL = "one-code:plan-file-path";
/** Session entry type persisting plan mode's allocated path across resume/branch (`{ path }`). */
export const PLAN_FILE_ENTRY = "one-code:plan-mode-file";

/** The plan file the branch's latest plan-file entry records, if any. */
export function planFileOnBranch(entries: readonly { type: string; customType?: string; data?: unknown }[]): string | undefined {
	let path: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PLAN_FILE_ENTRY) continue;
		const recorded = (entry.data as { path?: unknown } | undefined)?.path;
		if (typeof recorded === "string") path = recorded;
	}
	return path;
}

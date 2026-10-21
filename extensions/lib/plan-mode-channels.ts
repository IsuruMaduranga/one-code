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
/**
 * Session entry type persisting plan mode's allocated path across resume/branch
 * (`{ path, sessionId?, copiedFrom? }`): the session that allocated it, and the
 * plan a fork's copy was taken from.
 */
export const PLAN_FILE_ENTRY = "one-code:plan-mode-file";

export interface PlanFileRecord {
	path: string;
	sessionId?: string;
	copiedFrom?: string;
}

type EntryLike = { type: string; customType?: string; data?: unknown };

/** Every plan-file record in `entries`, oldest first. */
export function planFileRecords(entries: readonly EntryLike[]): PlanFileRecord[] {
	const records: PlanFileRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PLAN_FILE_ENTRY) continue;
		const data = entry.data as { path?: unknown; sessionId?: unknown; copiedFrom?: unknown } | undefined;
		if (typeof data?.path !== "string") continue;
		records.push({
			path: data.path,
			...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
			...(typeof data.copiedFrom === "string" ? { copiedFrom: data.copiedFrom } : {}),
		});
	}
	return records;
}

/** The plan file the branch's latest plan-file entry records, if any. */
export function planFileOnBranch(entries: readonly EntryLike[]): string | undefined {
	return planFileRecords(entries).at(-1)?.path;
}

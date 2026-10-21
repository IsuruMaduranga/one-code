/**
 * A plan-mode run as the branch records it (pure, no pi imports): its plan
 * file's path, whether that file existed when the run began, and the mode the
 * run came from. plan-mode/index.ts reads and writes the record.
 */
import type { PermissionMode } from "../permissions/matcher.ts";
import { normalizePermissionMode } from "../permissions/settings.ts";

/** The `one-code:state` key of the current plan-mode run. */
export const PLAN_ENTRY_STATE = "plan-mode:entry";

/** A plan-mode run as the branch records it, beside its plan file's path. */
export type PlanRun = { existed: boolean; modeBeforePlan?: PermissionMode };

/**
 * The run `stored` records for the plan file at `path`, or undefined when it
 * records another file or is malformed. A mode it came from that is unknown,
 * or plan itself, is dropped: the exit then offers its fixed list.
 */
export function parsePlanRun(stored: unknown, path: string): PlanRun | undefined {
	const record = stored as { path?: unknown; existed?: unknown; modeBeforePlan?: unknown } | null | undefined;
	if (record?.path !== path || typeof record.existed !== "boolean") return undefined;
	const mode = normalizePermissionMode(record.modeBeforePlan);
	const before = mode !== "plan" ? mode : undefined;
	return { existed: record.existed, ...(before ? { modeBeforePlan: before } : {}) };
}

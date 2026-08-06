/**
 * Permission-mode cycling and display (pure).
 *
 * Mirrors Claude Code v2.1: the cycle is manual (`default`) → acceptEdits →
 * plan → [bypassPermissions] → [auto]. bypassPermissions joins only when the
 * session was started with it enabled; `auto` joins when a classifier model is
 * reachable, mirroring how Claude Code drops auto from the cycle where its
 * requirements aren't met. `dontAsk` never appears in the cycle in Claude Code
 * either — it is reachable only via flag or settings.
 */

import type { PermissionMode } from "./matcher.ts";

/** Footer badge per mode — Claude Code's exact strings and icons. */
export const MODE_BADGES: Record<PermissionMode, string> = {
	default: "⏸ manual mode on",
	acceptEdits: "⏵⏵ accept edits on",
	plan: "⏸ plan mode on",
	bypassPermissions: "⏵⏵ bypass permissions on",
	dontAsk: "⏵⏵ don't ask on",
	auto: "⏵⏵ auto mode on",
};

const CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan"];

export interface CycleOptions {
	bypassInCycle: boolean;
	autoInCycle: boolean;
}

/**
 * The mode the cycle shortcut lands on next. A mode outside the cycle
 * (dontAsk, or bypass in a session that didn't start with it) exits to the
 * cycle's start rather than being unreachable-from.
 */
export function nextMode(current: PermissionMode, opts: CycleOptions): PermissionMode {
	const cycle: PermissionMode[] = [...CYCLE];
	if (opts.bypassInCycle) cycle.push("bypassPermissions");
	if (opts.autoInCycle) cycle.push("auto");
	const index = cycle.indexOf(current);
	return cycle[(index + 1) % cycle.length];
}

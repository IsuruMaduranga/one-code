/**
 * The `/loop` sentinels: the prompts a loop with no prompt of its own
 * schedules (loop-fire.ts expands them at fire time). A leaf module with no
 * imports, because the profile's text names them (extensions/sdk/profile.ts)
 * and must not load the loop's file reading with them.
 */

export const AUTONOMOUS_LOOP = "<<autonomous-loop>>";
export const AUTONOMOUS_LOOP_DYNAMIC = "<<autonomous-loop-dynamic>>";
export const LOOP_FILE_SENTINEL = "<<loop.md>>";
export const LOOP_FILE_DYNAMIC_SENTINEL = "<<loop.md-dynamic>>";

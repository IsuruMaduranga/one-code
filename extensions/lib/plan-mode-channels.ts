/**
 * Bus channels between plan-mode and permissions. They live here, not in
 * either extension, because permissions cannot import plan-mode (plan-mode
 * already imports `permissions/modes.ts`) and a string literal typed in two
 * places is the one way a channel rename silently disconnects a listener.
 */

/** Request a permission-mode change (`{ mode }`); permissions applies it. */
export const MODE_CHANNEL = "one-code:set-permission-mode";
/** Announces plan mode's one writable file (`{ path }`); the permissions matcher consumes it. */
export const PLAN_FILE_CHANNEL = "one-code:plan-file-path";

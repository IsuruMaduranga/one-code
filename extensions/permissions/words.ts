/**
 * The profile's permission-gate words for the gate's modules that run
 * without the extension's own context (the in-process child gate, the
 * parent bridge). Fails closed (`requireText`) when the profile has none:
 * the gate always runs.
 */

import { requireText } from "../lib/profile.ts";
import type { PermissionRefusal, PermissionsText } from "./text.ts";

export const permissionWords = (): PermissionsText => requireText("permissions");

/** Why the gate refused a call, in the profile's words. */
export const refusalText = (refusal: PermissionRefusal): string => permissionWords().refused(refusal);

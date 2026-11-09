/**
 * The profile's auto-mode words for the gate's pure modules (the classifier,
 * the stage-2 parser, the safety floor), which the permission gate and the
 * subagent bridges call without an extension of their own to hold them.
 * Fails closed (`requireText`) when the profile has none: the gate always runs.
 */

import { requireText } from "../../../lib/profile/profile.ts";
import type { AutoModeText } from "./text.ts";

export const autoModeWords = (): AutoModeText => requireText("autoMode");

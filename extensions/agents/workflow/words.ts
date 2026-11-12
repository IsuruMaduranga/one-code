/**
 * The profile's workflow words for the modules below the extension's entry
 * (the script parser, the runtime, the agent sessions), which throw messages
 * a script can read and so word them where they are thrown. The extension
 * itself checks the group at load (`requireText` in index.ts), so a run never
 * starts without it.
 */

import { requireText } from "../../lib/profile/profile.ts";
import type { WorkflowText } from "./text.ts";

export const workflowWords = (): WorkflowText => requireText("workflow");

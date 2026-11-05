/**
 * The profile's tool-result words for the base's shared rewrites
 * (empty-tool-result.ts, persisted-output.ts, user-denial.ts), which many
 * extensions call. Fails closed (`requireText`) without them.
 */

import { requireText } from "./profile.ts";
import type { ToolResultsText } from "./tool-results-text.ts";

export const toolResultWords = (): ToolResultsText => requireText("toolResults");

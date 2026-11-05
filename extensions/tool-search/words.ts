/**
 * The profile's tool-search words for lib/deferred.ts and
 * lib/tool-additions.ts, which the ledger and other extensions also call.
 * tool-search is part of the required core, so a profile must supply them
 * (`requireText` fails closed).
 */

import { requireText } from "../lib/profile.ts";
import type { ToolSearchText } from "./text.ts";

export const toolSearchWords = (): ToolSearchText => requireText("toolSearch");

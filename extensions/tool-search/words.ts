/**
 * The profile's tool-search words for lib/request/deferred.ts and
 * tool-search/tool-additions.ts, which the ledger and other extensions also call.
 * tool-search is part of the required core, so a profile must supply them
 * (`requireText` fails closed).
 */

import { requireText } from "../lib/profile/profile.ts";
import type { ToolSearchText } from "./text.ts";

export const toolSearchWords = (): ToolSearchText => requireText("toolSearch");

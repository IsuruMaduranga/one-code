/**
 * The profile's first-message context words for the base modules that build
 * it (instructions.ts, environment-block.ts, git-status.ts,
 * context-facts.ts, instruction-budget.ts). Fails closed (`requireText`):
 * every session sends this context.
 */

import type { ContextText } from "./context-text.ts";
import { requireText } from "../profile/profile.ts";

export const contextWords = (): ContextText => requireText("context");

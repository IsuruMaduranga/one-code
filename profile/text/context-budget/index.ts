/**
 * One Code's context-budget text (the profile's `text.contextBudget`): what Claude
 * Code puts inside its `<total_tokens>` block, byte for byte.
 */

import type { ContextBudgetText } from "../../../extensions/context-budget/text.ts";

export const contextBudget: ContextBudgetText = {
	clearAtNudge: "First privately list what you need next; then request every item that doesn't depend on another's result in this one response.",
	tokensLeft: ({ left }) => `${left} tokens left`,
};

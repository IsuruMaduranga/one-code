/**
 * One Code's context-budget text (the profile's `text.contextBudget`): what Claude
 * Code puts inside its `<total_tokens>` block, byte for byte.
 */

import type { ContextBudgetText } from "../../extensions/context-budget/text.ts";

export const contextBudget: ContextBudgetText = {
	tokensLeft: ({ left }) => `${left} tokens left`,
};

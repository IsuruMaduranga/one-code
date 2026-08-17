/**
 * Pure tier → tool-surface policy: which of pi's inactive built-in search
 * tools should be active for a given prompt tier.
 */

import type { PromptTier } from "../lib/model-tier.ts";

/** pi built-ins that exist in the registry but are not active by default. */
export const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

/**
 * Returns the active-tool list adjusted for the tier: only `tiny` gains the
 * search tools (deduped, appended in a stable order); frontier/workhorse/cheap
 * lose them. Claude Code ships no dedicated search tools on any tier (Haiku
 * included — bash covers search), so `cheap` matches CC exactly; the grep/find/ls
 * crutch is reserved for the sub-Haiku `tiny` models CC never serves. Order of
 * the existing names is preserved so the rebuilt system prompt stays byte-stable.
 */
export function withSearchTools(active: string[], tier: PromptTier): string[] {
	if (tier !== "tiny") {
		const drop = new Set<string>(SEARCH_TOOLS);
		return active.filter((name) => !drop.has(name));
	}
	const present = new Set(active);
	return [...active, ...SEARCH_TOOLS.filter((name) => !present.has(name))];
}

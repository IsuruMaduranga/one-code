/**
 * Pure tier → tool-surface policy: which of pi's inactive built-in search
 * tools should be active for a given prompt tier.
 */

import type { PromptTier } from "../lib/model-tier.ts";

/** pi built-ins that exist in the registry but are not active by default. */
export const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

/**
 * Returns the active-tool list adjusted for the tier: mid/low gain the search
 * tools (deduped, appended in a stable order), frontier loses them (Claude
 * Code's frontier surface has no dedicated search tools). Order of the
 * existing names is preserved so the rebuilt system prompt stays byte-stable.
 */
export function withSearchTools(active: string[], tier: PromptTier): string[] {
	if (tier === "frontier") {
		const drop = new Set<string>(SEARCH_TOOLS);
		return active.filter((name) => !drop.has(name));
	}
	const present = new Set(active);
	return [...active, ...SEARCH_TOOLS.filter((name) => !present.has(name))];
}

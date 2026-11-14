/**
 * Pure tool-surface policy for pi's inactive built-in search tools: all three
 * active when the session has them (`searchToolsEnabled`), none otherwise.
 */

import { SEARCH_TOOLS } from "../../lib/models/model-tier.ts";

/**
 * The active-tool list with the search tools added (deduped, appended in a
 * stable order) when `enabled`, and removed otherwise. The order of the other
 * names is kept, so the rebuilt system prompt stays byte-stable.
 */
export function withSearchTools(active: string[], enabled: boolean): string[] {
	if (!enabled) {
		const drop = new Set<string>(SEARCH_TOOLS);
		return active.filter((name) => !drop.has(name));
	}
	const present = new Set(active);
	return [...active, ...SEARCH_TOOLS.filter((name) => !present.has(name))];
}

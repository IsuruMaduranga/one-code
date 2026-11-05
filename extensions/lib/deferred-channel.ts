/**
 * The deferral channel, in a module of its own so a light caller
 * (lib/feature.ts, loaded by every extension) can emit on it without importing
 * lib/deferred.ts and the ledger behind it. lib/deferred.ts re-exports both.
 * Any extension can defer its own tools by emitting on DEFER_CHANNEL with
 * `{ name, keywords? }`; tool-search is the one listener.
 */

export const DEFER_CHANNEL = "one-code:defer-tool";

export interface DeferRequest {
	name: string;
	/** Extra search terms beyond the tool's name and description. */
	keywords?: string[];
}

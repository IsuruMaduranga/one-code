/**
 * The deferral channel, in a module of its own so a light caller
 * (lib/profile/feature.ts, loaded by every extension) can emit on it without importing
 * lib/request/deferred.ts and the ledger behind it. lib/request/deferred.ts re-exports both.
 * Any extension can defer its own tools by emitting on DEFER_CHANNEL with
 * `{ name, keywords?, hint? }`; tool-search is the one listener.
 */

import { brandedId } from "../profile/brand.mjs";

export const DEFER_CHANNEL = brandedId("defer-tool");

export interface DeferRequest {
	name: string;
	/** Extra search terms beyond the tool's name and description. */
	keywords?: string[];
	/**
	 * One line on when to load the tool, for its deferred-listing line
	 * (`name: hint`) when the profile has no hint for that name; a profile
	 * hint always wins. Listing text only: no other field of the tool changes.
	 */
	hint?: string;
}

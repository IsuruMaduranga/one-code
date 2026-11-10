/**
 * What a profile says about a model provider (working-docs/decisions/bi-fork.md):
 * whose models it serves and which Anthropic wire features its endpoint
 * accepts. Types and constants only, so the contract, the profile resolver
 * and lib/models/model-policy.ts can all import it.
 *
 * The base knows pi's built-in providers by name. A product that registers
 * its own provider (its sign-in proxy), or that vouches for a cloud host's
 * copies, declares it here; without an entry a custom provider is opaque:
 * the tiny tier, no catalog match, no Anthropic wire features.
 */

/** The vendors a provider entry may name: each is a built-in direct provider's profile (`product-providers.test.ts`). */
export const PROVIDER_VENDORS = ["anthropic", "openai", "google"] as const;
export type ProviderVendor = (typeof PROVIDER_VENDORS)[number];

/**
 * The Anthropic request features the base sends only where the endpoint is
 * known to accept them. Anthropic's own provider takes all of them; a
 * product's provider takes the ones its entry lists.
 *
 * - `tool-references`: client-side `tool_reference` blocks (lib/request/deferred.ts).
 * - `tool-additions`: reference-form tool additions in a system message (request/tool-search/tool-additions.ts).
 * - `system-role`: the mid-conversation system message beta and its per-turn shapes (request/system-reminder).
 * - `context-management`: the `clear_thinking` edit, on by default (request/context-management).
 */
export const WIRE_FEATURES = ["tool-references", "tool-additions", "system-role", "context-management"] as const;
export type WireFeature = (typeof WIRE_FEATURES)[number];

export interface ProductProvider {
	/**
	 * The vendor whose own models this provider serves. A provider pi does not
	 * build in is then treated as that vendor's direct provider (ids as the
	 * vendor writes them). A built-in host (`amazon-bedrock`) keeps its own id
	 * parsing, and its rows of this vendor count as the vendor's own models.
	 */
	serves: ProviderVendor;
	/** The Anthropic wire features the endpoint accepts (`serves: "anthropic"` only). None when left out. */
	wire?: readonly WireFeature[];
}

/** The problems in a profile's provider entries, for the resolver to report with the rest. */
export function providerProblems(providers: Readonly<Record<string, ProductProvider>>): string[] {
	const problems: string[] = [];
	for (const [name, entry] of Object.entries(providers)) {
		// Anthropic's own provider already has every feature; redeclaring it could only take some away by mistake.
		if (name === "anthropic") problems.push(`provider "anthropic" is the base's own and cannot be redeclared`);
		if (!(PROVIDER_VENDORS as readonly string[]).includes(entry.serves)) problems.push(`provider "${name}" serves an unknown vendor "${entry.serves}"`);
		for (const feature of entry.wire ?? []) {
			if (!(WIRE_FEATURES as readonly string[]).includes(feature)) problems.push(`provider "${name}" lists an unknown wire feature "${feature}"`);
		}
		if ((entry.wire?.length ?? 0) > 0 && entry.serves !== "anthropic") problems.push(`provider "${name}" lists wire features but does not serve anthropic`);
	}
	return problems;
}

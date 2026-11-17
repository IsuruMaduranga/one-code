/**
 * The four model tiers by name (pure, no imports): what a profile may key a
 * per-tier value by, checked when the profile resolves. A leaf, so the
 * profile's resolver can name the tiers without loading the classifier
 * (`model-tier.ts`), whose policy imports the resolver back.
 */

export type PromptTier = "frontier" | "workhorse" | "cheap" | "tiny";

/** More-scaffolded = higher rank. */
export const TIER_RANK: Readonly<Record<PromptTier, number>> = { frontier: 0, workhorse: 1, cheap: 2, tiny: 3 };

/** Every prompt tier, most capable first. */
export const PROMPT_TIERS = Object.keys(TIER_RANK) as readonly PromptTier[];

/** Whether `value` names one of the four tiers. */
export function isPromptTier(value: unknown): value is PromptTier {
	return typeof value === "string" && Object.hasOwn(TIER_RANK, value);
}

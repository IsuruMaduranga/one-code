/**
 * The thinking level a profile declares per model tier
 * (`Profile.defaultThinkingLevels`), and its load check. Pure: no pi imports,
 * so the profile's own graph can name the levels.
 *
 * The effort feature applies the level (lib/models/tier-thinking.ts decides
 * when): a new session's model, and a model switch, take their tier's level
 * unless the user chose one. A tier the profile leaves out keeps pi's own
 * resolution.
 */

import { isPromptTier, PROMPT_TIERS, type PromptTier } from "../models/prompt-tiers.ts";

/** pi's thinking levels, lowest first (pi-coding-agent `cli/args.js` VALID_THINKING_LEVELS). */
export const THINKING_LEVEL_NAMES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVEL_NAMES)[number];

/** The level a profile declares for each tier it names: `{ cheap: "low", tiny: "low", workhorse: "medium" }`. */
export type ThinkingDefaults = Readonly<Partial<Record<PromptTier, ThinkingLevelName>>>;

/** Whether `value` is one of pi's thinking levels. */
export function isThinkingLevelName(value: unknown): value is ThinkingLevelName {
	return typeof value === "string" && (THINKING_LEVEL_NAMES as readonly string[]).includes(value);
}

/** What is wrong with a declared map: a key that is not a tier, a value that is not a level; one sentence each. */
export function thinkingDefaultProblems(declared: Readonly<Record<string, unknown>>): string[] {
	const problems: string[] = [];
	for (const [tier, level] of Object.entries(declared)) {
		if (!isPromptTier(tier)) problems.push(`defaultThinkingLevels names "${tier}", which is not a model tier (${PROMPT_TIERS.join(", ")})`);
		else if (!isThinkingLevelName(level)) problems.push(`defaultThinkingLevels.${tier} is ${JSON.stringify(level)}, which is not a thinking level (${THINKING_LEVEL_NAMES.join(", ")})`);
	}
	return problems;
}

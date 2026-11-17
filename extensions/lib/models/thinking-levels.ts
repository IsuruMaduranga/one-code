/**
 * The thinking levels one model can reach, and how pi fits any level to it
 * (pure: a thin reading of pi-ai's `getSupportedThinkingLevels` and
 * `clampThinkingLevel`, so the effort feature and a product extension agree).
 *
 * pi never refuses a level the model lacks: it fits it (`low` runs as `high`
 * on a model with no `low`) and then announces `thinking_level_select` with
 * the fitted level. A listener cannot tell that from the user picking the
 * level, so it asks `settle` what the level it set would become and compares.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { THINKING_LEVEL_NAMES, type ThinkingLevelName } from "../profile/thinking-defaults.ts";

export interface ThinkingLevels {
	/** The levels the model reaches, lowest first; the whole ladder when there is no model. */
	readonly supported: readonly ThinkingLevelName[];
	/** The level pi runs when `level` is set on this model; `level` itself when the model reaches it. */
	settle(level: ThinkingLevelName): ThinkingLevelName;
}

/** The levels of `model` (`undefined`: no model chosen yet, so nothing is fitted). */
export function thinkingLevelsFor(model: Model<Api> | undefined): ThinkingLevels {
	if (!model) return { supported: THINKING_LEVEL_NAMES, settle: (level) => level };
	return {
		supported: getSupportedThinkingLevels(model) as ThinkingLevelName[],
		settle: (level) => clampThinkingLevel(model, level) as ThinkingLevelName,
	};
}

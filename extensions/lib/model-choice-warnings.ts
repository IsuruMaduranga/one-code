/**
 * Warnings for a model the user chose by hand for a secondary role: the
 * subagent default (`/subagent`) or the auto-mode classifier
 * (`/auto-mode model`). Pure: no pi imports. Automatic selection never needs
 * them (it skips superseded models and never goes below the session's tier);
 * a hand choice is honoured, so these say what it costs instead of refusing it.
 * The session model's own newer-model notice lives in `extensions/newer-model`.
 *
 * - **Newer model:** the same model line has a newer release at about the same
 *   price (`newerModelSuggestion`).
 * - **Far weaker than the session:** two or more tiers below the session model
 *   (a frontier session with a cheap or tiny model, a workhorse one with tiny).
 * - **Classifier only, smaller context window:** the classifier receives the
 *   whole transcript, so once the session outgrows the chosen model's window
 *   each call goes unjudged and asks for approval until `/compact`.
 *
 * working-docs/decisions/model-policy.md ("Warnings on a chosen model").
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { hasCatalogContextWindow, modelSpec as spec } from "./model-policy.ts";
import { intrinsicTier, tiersBelow } from "./model-tier.ts";
import { newerModelSuggestion } from "./newer-model.ts";

export type ChosenModelRole = "subagent" | "classifier";

export interface ChosenModelWarning {
	kind: "newer" | "weaker" | "window";
	text: string;
	/** What to run instead, in the role's own command. */
	fix: string;
}

/** Tiers below the session at which a chosen model is "far weaker" (the text says "two or more"). */
const WEAKER_TIER_GAP = 2;

const COMMAND: Record<ChosenModelRole, string> = { subagent: "/subagent", classifier: "/auto-mode model" };
const LABEL: Record<ChosenModelRole, string> = { subagent: "subagent default", classifier: "auto-mode classifier" };

/** Every warning that applies to `chosen` in `role` for this session, most important first. */
export function chosenModelWarnings({
	available,
	sessionModel,
	chosen,
	role,
	suggestNewer = true,
}: {
	available: readonly Model<Api>[];
	sessionModel: Model<Api> | undefined;
	chosen: Model<Api>;
	role: ChosenModelRole;
	/** `suggestNewerModels` in ~/.onecode/settings.json; false drops the newer-model warning. */
	suggestNewer?: boolean;
}): ChosenModelWarning[] {
	const warnings: ChosenModelWarning[] = [];
	const command = COMMAND[role];
	const label = LABEL[role];
	const orAutomatic = `or ${command} clear for the automatic choice.`;
	const isSession = !!sessionModel && sessionModel.provider === chosen.provider && sessionModel.id === chosen.id;

	if (sessionModel && !isSession) {
		const chosenTier = intrinsicTier(chosen);
		const sessionTier = intrinsicTier(sessionModel);
		if (tiersBelow(chosenTier, sessionTier) >= WEAKER_TIER_GAP) {
			const why =
				role === "classifier"
					? "A weak classifier is a weak permission boundary: it may let through calls a stronger one would stop."
					: "A much weaker subagent tends to spend the saving on retries and mistakes.";
			warnings.push({
				kind: "weaker",
				text: `The ${label} ${spec(chosen)} is a ${chosenTier}-tier model, two or more tiers below this session's ${spec(sessionModel)} (${sessionTier}). ${why}`,
				fix: `Pick a stronger one with ${command}, ${orAutomatic}`,
			});
		}
		if (role === "classifier" && hasCatalogContextWindow(chosen) && hasCatalogContextWindow(sessionModel) && sessionModel.contextWindow > chosen.contextWindow) {
			warnings.push({
				kind: "window",
				text:
					`The ${label} ${spec(chosen)} has a ${chosen.contextWindow.toLocaleString("en-US")}-token context window, smaller than this session's ` +
					`${sessionModel.contextWindow.toLocaleString("en-US")}. The classifier reads the whole transcript: once the session outgrows it, ` +
					"calls are not judged and each asks for your approval (a headless run stops) until you /compact.",
				fix: `Pick a model with a larger window with ${command}, ${orAutomatic}`,
			});
		}
	}

	const newer = suggestNewer ? newerModelSuggestion(available, chosen) : undefined;
	if (newer) {
		warnings.push({
			kind: "newer",
			text: `The ${label} ${spec(chosen)} has a newer model in its line: ${newer.text}`,
			fix: `Switch with ${command} ${spec(newer.model)}.`,
		});
	}
	return warnings;
}

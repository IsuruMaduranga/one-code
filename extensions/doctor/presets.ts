/**
 * Model presets (pure): three named configurations — economical, balanced,
 * maximum quality — computed against the models the user can actually run,
 * shown with the concrete model each role would get, and applied with
 * `/doctor preset <name>`.
 *
 * Presets never leave the current provider family: every automatic model choice
 * in One Code is contained to the session's provider (a subagent inherits the
 * transcript, the classifier reads the prompts — working-docs/decisions/model-policy.md),
 * and a preset is a bundle of those same choices. A user who wants another
 * provider switches with /model first and reruns /doctor presets there.
 *
 * Each preset pins ONE thing — the main model — and sets the two secondary
 * knobs to the shape that matches its intent:
 *   economical        main = cheapest capable (cheap tier, never tiny); subagents inherit it;
 *                     classifier automatic (lands on the same model)
 *   balanced          main = cheapest workhorse-tier model; subagents automatic (the
 *                     cheapest model at the main's floor — often the main itself,
 *                     since subagents share the classifier's workhorse floor);
 *                     classifier automatic (workhorse floor)
 *   maximum quality   main = the strongest (frontier, else priciest workhorse);
 *                     subagents inherit it; classifier automatic
 * so applying a preset is three settings writes the user can each undo by hand
 * (/model, /subagent, /auto-mode model). The rows display what the resolvers
 * would pick for that main model, computed with the resolvers themselves.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { classifierCandidates } from "../auto-mode/model-select.ts";
import { isPriorGeneration, lacksToolCalls } from "../lib/model-facts.ts";
import { isDatedDuplicate, modelsContainedToSession, modelSpec, pricedInput } from "../lib/model-policy.ts";
import { intrinsicTier, type PromptTier } from "../lib/model-tier.ts";
import { resolveSubagentModel } from "../subagents/model-select.ts";
import type { ReportLine, ReportSection } from "./report.ts";

export type PresetName = "economical" | "balanced" | "quality";

export const PRESET_NAMES: readonly PresetName[] = ["economical", "balanced", "quality"];

export const PRESET_LABEL: Record<PresetName, string> = {
	economical: "economical",
	balanced: "balanced",
	quality: "maximum quality",
};

export const PRESET_INTENT: Record<PresetName, string> = {
	economical: "lowest cost — one cheap model for everything",
	balanced: "a capable main model, delegated work on the cheapest model at its floor",
	quality: "the strongest model for the main session and its subagents",
};

export interface PresetPlan {
	name: PresetName;
	label: string;
	main: Model<Api>;
	/** What subagents resolve to under this preset, and the setting that produces it. */
	subagents: { model: Model<Api>; setting: "inherit" | "auto" };
	classifier?: Model<Api>;
	/** True when the main session already runs this preset's main model. */
	current: boolean;
	/** Why the pick is weaker than the preset promises (one provider, one model…). */
	note?: string;
}

/** Only well-known reasons a preset list is empty; the section renders them. */
export type PresetsUnavailable = "no-model" | "no-priced-models";

/**
 * The candidate pool for one provider family: contained, priced, dated duplicates
 * collapsed when the undated alias is present (`claude-haiku-4-5-20251001` next
 * to `claude-haiku-4-5`). Tiny-tier rows stay in the pool only as a last resort.
 */
export function presetPool(available: Model<Api>[], sessionModel: Model<Api>): Model<Api>[] {
	const contained = modelsContainedToSession(available, sessionModel).filter(
		// A preset recommends a MAIN model: never one a generation behind its family
		// or one models.dev says cannot call tools (model-facts.ts), whatever its tier.
		(m) => pricedInput(m) !== undefined && !isPriorGeneration(m) && !lacksToolCalls(m),
	);
	return contained.filter((m) => !isDatedDuplicate(m, contained));
}

const price = (m: Model<Api>): number => pricedInput(m) ?? 0;
const byTier = (pool: Model<Api>[], tier: PromptTier): Model<Api>[] => pool.filter((m) => intrinsicTier(m) === tier);
const cheapest = (models: Model<Api>[]): Model<Api> | undefined => [...models].sort((a, b) => price(a) - price(b))[0];
const priciest = (models: Model<Api>[]): Model<Api> | undefined => [...models].sort((a, b) => price(b) - price(a))[0];

function pickMain(name: PresetName, pool: Model<Api>[]): { model: Model<Api>; note?: string } | undefined {
	const cheap = byTier(pool, "cheap");
	const workhorse = byTier(pool, "workhorse");
	const frontier = byTier(pool, "frontier");
	const capable = [...cheap, ...workhorse, ...frontier];
	switch (name) {
		case "economical": {
			const pick = cheapest(cheap) ?? cheapest(workhorse) ?? cheapest(frontier);
			if (pick) return { model: pick, note: cheap.length === 0 ? "no cheap-tier model on this provider; the cheapest capable one serves" : undefined };
			const tiny = cheapest(pool);
			return tiny ? { model: tiny, note: "only tiny-tier models on this provider — expect weaker results" } : undefined;
		}
		case "balanced": {
			const pick = cheapest(workhorse) ?? cheapest(frontier) ?? priciest(cheap);
			if (pick) return { model: pick, note: workhorse.length === 0 ? "no workhorse-tier model on this provider" : undefined };
			const any = priciest(pool);
			return any ? { model: any, note: "only tiny-tier models on this provider — expect weaker results" } : undefined;
		}
		case "quality": {
			const pick = priciest(frontier) ?? priciest(workhorse) ?? priciest(capable) ?? priciest(pool);
			if (!pick) return undefined;
			const note =
				frontier.length === 0 && workhorse.length === 0
					? "no frontier- or workhorse-tier model on this provider"
					: frontier.length === 0
						? "no frontier-tier model on this provider; the strongest workhorse serves"
						: undefined;
			return { model: pick, note };
		}
	}
}

/**
 * The three presets for the session's provider family. Empty with a reason when
 * there is no session model (nothing to contain to) or no priced model (tiers
 * cannot be told apart, so a preset would be a guess).
 */
export function computePresets(
	available: Model<Api>[],
	sessionModel: Model<Api> | undefined,
): { presets: PresetPlan[]; unavailable?: PresetsUnavailable } {
	if (!sessionModel) return { presets: [], unavailable: "no-model" };
	const pool = presetPool(available, sessionModel);
	if (pool.length === 0) return { presets: [], unavailable: "no-priced-models" };

	const presets: PresetPlan[] = [];
	for (const name of PRESET_NAMES) {
		const main = pickMain(name, pool);
		if (!main) continue;
		const inherit = name !== "balanced";
		// The resolvers judge the preset's main model as if it were the session's,
		// over the same catalog the live session uses, so the preview names exactly
		// what applying the preset produces.
		const subagentModel = inherit
			? main.model
			: (resolveSubagentModel({ sessionModel: main.model, available }).model ?? main.model);
		const classifier = classifierCandidates({ available, sessionModel: main.model }).candidates[0]?.model;
		presets.push({
			name,
			label: PRESET_LABEL[name],
			main: main.model,
			subagents: { model: subagentModel, setting: inherit ? "inherit" : "auto" },
			classifier,
			current: modelSpec(main.model) === modelSpec(sessionModel),
			note: main.note,
		});
	}
	return { presets };
}

export function findPreset(presets: PresetPlan[], raw: string): PresetPlan | undefined {
	const wanted = raw.trim().toLowerCase().replace(/\s+/g, "-");
	const aliases: Record<string, PresetName> = { economical: "economical", economy: "economical", cheap: "economical", balanced: "balanced", balance: "balanced", quality: "quality", "maximum-quality": "quality", max: "quality", maximum: "quality", best: "quality" };
	const name = aliases[wanted];
	return name ? presets.find((p) => p.name === name) : undefined;
}

const shortId = (m: Model<Api>): string => m.id;

export function presetsSection(result: ReturnType<typeof computePresets>, sessionModel: Model<Api> | undefined): ReportSection {
	const lines: ReportLine[] = [];
	if (result.unavailable === "no-model") {
		lines.push({ text: "Connect a provider first (/login); presets are computed for the provider your main model runs on.", level: "dim" });
		return { title: "Presets", lines };
	}
	if (result.unavailable === "no-priced-models" || result.presets.length === 0) {
		lines.push({ text: "No priced models on this provider, so tiers cannot be told apart and no preset is offered.", level: "dim" });
		return { title: "Presets", lines };
	}
	const family = sessionModel ? sessionModel.provider : "";
	for (const preset of result.presets) {
		const sub = preset.subagents.setting === "inherit" ? "same" : shortId(preset.subagents.model);
		const cls = preset.classifier ? shortId(preset.classifier) : "none";
		const cost = pricedInput(preset.main);
		const tail = [cost !== undefined ? `$${cost}/M in` : "", preset.current ? "← current main model" : ""].filter(Boolean).join(" · ");
		lines.push({
			text: `${preset.label}: main ${shortId(preset.main)} · subagents ${sub} · classifier ${cls}${tail ? ` — ${tail}` : ""}`,
			level: preset.current ? "ok" : "info",
		});
		lines.push({ text: PRESET_INTENT[preset.name] + (preset.note ? ` (${preset.note})` : ""), indent: 1, level: "dim" });
	}
	return {
		title: "Presets",
		subtitle: `within ${family} · apply with /doctor preset <economical|balanced|quality>`,
		lines,
	};
}

/**
 * The three settings writes a preset amounts to, one line each with its undo —
 * the text `/doctor preset` reports after applying. `mainSwitched` false means
 * the session already ran the preset's main model, so that line says so.
 */
export function describePresetChanges(preset: PresetPlan, mainSwitched = true): string[] {
	return [
		mainSwitched ? `main model → ${modelSpec(preset.main)} (undo: /model)` : `main model: already ${modelSpec(preset.main)}`,
		preset.subagents.setting === "inherit"
			? "subagent default → inherit the main model (undo: /subagent clear)"
			: `subagent default → automatic (picks ${modelSpec(preset.subagents.model)}; undo: /subagent)`,
		`auto-mode classifier → automatic${preset.classifier ? ` (picks ${modelSpec(preset.classifier)})` : ""} (undo: /auto-mode model)`,
	];
}

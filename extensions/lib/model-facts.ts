/**
 * Facts about models that pi's catalog strips: release date and tool-calling
 * support, from models.dev, bundled as `model-facts.generated.json` and refreshed
 * with each pi bump (`scripts/gen-model-facts.mjs`). Pure: reads one
 * JSON file lazily, no pi imports.
 *
 * Why release dates: the tier price floors are absolute dollars calibrated on US
 * vendor prices, and nothing else in the classifier knew a model's generation,
 * so on a ~10x-cheaper vendor a boundary-priced 2025 model (deepseek-r1-0528)
 * beat a 2026 model priced below the floor (V4 Flash). A model's *generation* is
 * measured against its vendor family's newest release, never against today, so
 * a family that ships rarely is not aged by the calendar.
 * docs/features/tiering/plan.md (Phase 1), docs/decisions/model-tiers.md.
 *
 * Lookups resolve OpenRouter's `~vendor/id` redirect aliases and `:variant`
 * endpoints through their base id. A row models.dev does not know has no facts
 * and gets the price-and-name behaviour that preceded this module.
 */

import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelIdentity } from "./model-policy.ts";

export interface ModelFactsRow {
	/** ISO date (YYYY-MM-DD) the model was released, per models.dev. */
	releaseDate: string;
	/** Present only when models.dev marks the model as NOT supporting tool calls. */
	toolCall?: false;
}

interface FactsFile {
	facts: Record<string, ModelFactsRow>;
}

/** A model released this many days before its family's newest is one generation behind. */
export const PRIOR_GENERATION_DAYS = 365;
/** …and this many days behind is two generations: maximum scaffolding, never auto-selected. */
export const ANCIENT_GENERATION_DAYS = 730;

const DAY_MS = 86_400_000;

let loaded: { facts: Record<string, ModelFactsRow>; familyNewest: Map<string, number> } | undefined;

/** Test seam: replace the bundled table (pass `undefined` to restore it). */
export function setModelFactsForTest(facts: Record<string, ModelFactsRow> | undefined): void {
	loaded = facts ? index(facts) : undefined;
}

function load(): NonNullable<typeof loaded> {
	if (loaded) return loaded;
	let facts: Record<string, ModelFactsRow> = {};
	try {
		const file = JSON.parse(readFileSync(new URL("./model-facts.generated.json", import.meta.url), "utf8")) as FactsFile;
		if (file && typeof file.facts === "object") facts = file.facts;
	} catch {
		// A missing or unreadable table means "no facts": every row degrades to the
		// pre-facts price-and-name behaviour rather than throwing inside selection.
	}
	loaded = index(facts);
	return loaded;
}

/**
 * The vendor family a row's generation is judged within: the canonical vendor
 * when the identity policy knows it (so `openrouter/deepseek/…` and the direct
 * `deepseek` provider share one family), else the containment key.
 */
export function modelFamily(model: { provider: string; id: string }): string {
	const identity = modelIdentity(model as Model<Api>);
	return identity.profile ?? identity.containment;
}

function index(facts: Record<string, ModelFactsRow>) {
	const familyNewest = new Map<string, number>();
	for (const [key, row] of Object.entries(facts)) {
		const slash = key.indexOf("/");
		if (slash <= 0) continue;
		const model = { provider: key.slice(0, slash), id: key.slice(slash + 1) };
		// Variants and redirect aliases carry no generation of their own.
		if (/:[a-z]+$/i.test(model.id) || model.id.startsWith("~")) continue;
		const t = Date.parse(row.releaseDate);
		if (Number.isNaN(t)) continue;
		const family = modelFamily(model);
		if (t > (familyNewest.get(family) ?? -Infinity)) familyNewest.set(family, t);
	}
	return { facts, familyNewest };
}

function baseId(id: string): string {
	const noAlias = id.startsWith("~") ? id.slice(1) : id;
	return noAlias.replace(/:[a-z]+$/i, "");
}

/** The models.dev row for a model, resolved through alias and variant spellings. */
export function modelFacts(model: { provider: string; id: string }): ModelFactsRow | undefined {
	const { facts } = load();
	return facts[`${model.provider}/${model.id}`] ?? facts[`${model.provider}/${baseId(model.id)}`];
}

/** Whether models.dev says the model cannot call tools (undefined = unknown or yes). */
export function lacksToolCalls(model: { provider: string; id: string }): boolean {
	return modelFacts(model)?.toolCall === false;
}

/**
 * How many days behind its family's newest release the model is, or undefined
 * when either date is unknown. 0 for the newest model itself.
 */
export function generationLagDays(model: { provider: string; id: string }): number | undefined {
	const row = modelFacts(model);
	if (!row) return undefined;
	const released = Date.parse(row.releaseDate);
	if (Number.isNaN(released)) return undefined;
	const newest = load().familyNewest.get(modelFamily(model));
	if (newest === undefined) return undefined;
	return Math.max(0, Math.round((newest - released) / DAY_MS));
}

export type Generation = "current" | "prior" | "ancient";

/** The model's generation relative to its family, or undefined without facts. */
export function modelGeneration(model: { provider: string; id: string }): Generation | undefined {
	const lag = generationLagDays(model);
	if (lag === undefined) return undefined;
	if (lag > ANCIENT_GENERATION_DAYS) return "ancient";
	if (lag > PRIOR_GENERATION_DAYS) return "prior";
	return "current";
}

/** Prior or ancient: excluded from every automatic pick (subagent, classifier, reader, presets). */
export function isPriorGeneration(model: { provider: string; id: string }): boolean {
	const generation = modelGeneration(model);
	return generation === "prior" || generation === "ancient";
}

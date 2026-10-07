/** Same-line upgrades at a comparable blended price. Selection only; never switches a model. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { catalogModelFor } from "./model-catalog.ts";
import { baseModelId, isAliasOrVariantId, isExperimentalBuild, modelSpec, stripSnapshotDate } from "./model-policy.ts";

interface ModelLine {
	line: string;
	version: number[];
}

/** Mask the first version, not dates, size tags, or digits in a gateway's author name. */
export function modelLine(id: string): ModelLine | undefined {
	const base = stripSnapshotDate(baseModelId(id).toLowerCase().replace(/-20\d{2}-\d{2}-\d{2}$/, ""));
	const slash = base.lastIndexOf("/");
	const name = base.slice(slash + 1);
	// Claude spells minor versions with hyphens on its direct provider, but
	// dots on gateways. Keep size/class suffixes for every other model line.
	const claude = name.match(/^claude-(?:opus|sonnet|haiku|fable)-(\d+(?:[-.]\d{1,2})?)/);
	const match = claude ? /\d+(?:[-.]\d{1,2})?/.exec(claude[0]) : /\d+(?:\.\d+)*/.exec(name);
	if (!match || match.index === undefined) return undefined;
	// Four-digit date/version stamps (Mistral's 2407/2512, for example) do
	// not prove a version upgrade. Leave ambiguous calendar names unpaired.
	if (match[0].split(/[.-]/)[0].length >= 4) return undefined;
	const end = match.index + match[0].length;
	if (/^[bm](?:-|$)/.test(name.slice(end))) return undefined;
	return {
		line: `${base.slice(0, slash + 1)}${name.slice(0, match.index)}#${name.slice(end)}`,
		version: match[0].split(/[.-]/).map(Number),
	};
}

function compareVersion(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const difference = (a[i] ?? 0) - (b[i] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

/** Catalog zeroes are unpriced sentinels, not a promise of free tokens. */
function blendedPrice(model: Model<Api>): number | undefined {
	const input = model.cost?.input;
	const output = model.cost?.output;
	if (!Number.isFinite(input) || !Number.isFinite(output) || !(input > 0) || !(output > 0)) return undefined;
	const blend = (3 * input + output) / 4;
	return Number.isFinite(blend) ? blend : undefined;
}

export interface NewerModelSuggestion {
	model: Model<Api>;
	text: string;
	fix: string;
}

/**
 * Available models only, on the session's provider and exact model line,
 * dated by the model catalogs (`model-catalog.ts`); this path never fetches.
 * Unlike secondary-model selection, tiny tiers are allowed: Qwen 27B upgrading
 * within its own line is useful advice, not an automatic delegation decision.
 */
export function newerModelSuggestion(
	available: readonly Model<Api>[],
	current: Model<Api> | undefined,
): NewerModelSuggestion | undefined {
	if (!current) return undefined;
	const currentLine = modelLine(current.id);
	const currentDate = catalogModelFor(current)?.released;
	const currentPrice = blendedPrice(current);
	if (!currentLine || currentDate === undefined || currentPrice === undefined) return undefined;
	const candidates = [];
	for (const model of available) {
		if (model.provider !== current.provider || isAliasOrVariantId(model.id)) continue;
		// Experimental endpoints and moving "latest" aliases have no stable
		// upgrade identity, even when their catalog row includes a release date.
		if (isExperimentalBuild(model.id) || /-latest(?:-|$)/i.test(model.id)) continue;
		const line = modelLine(model.id);
		if (!line || line.line !== currentLine.line || compareVersion(line.version, currentLine.version) <= 0) continue;
		const entry = catalogModelFor(model);
		const date = entry?.released;
		const price = blendedPrice(model);
		if (!entry || date === undefined || date <= currentDate || price === undefined || price > currentPrice * 1.1) continue;
		if (!entry.tools || entry.legacy || entry.deprecated) continue;
		candidates.push({ model, version: line.version, date, price });
	}
	candidates.sort((a, b) => compareVersion(b.version, a.version) || b.date - a.date || a.price - b.price);
	const pick = candidates[0];
	if (!pick) return undefined;
	const pricePair = (model: Model<Api>) => `$${formatPrice(model.cost.input)}/$${formatPrice(model.cost.output)}`;
	const comparison = pick.price < currentPrice * 0.9 ? "costs less" : "costs about the same";
	return {
		model: pick.model,
		text: `${pick.model.id} is newer than ${current.id} and ${comparison} (${pricePair(pick.model)} vs ${pricePair(current)} per M tokens).`,
		fix: `Switch with /model ${modelSpec(pick.model)}.`,
	};
}

/** At least cents, without rounding low per-token catalog prices to zero. */
function formatPrice(price: number): string {
	return String(price).includes("e") ? String(price) : price.toFixed(Math.max(2, (String(price).split(".")[1] ?? "").length));
}

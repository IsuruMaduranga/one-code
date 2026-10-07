/**
 * The tier algorithm's catalog side: every vendor model the public catalogs
 * know (`model-catalog-data.ts`), each placed in a tier by its size, its price
 * and its age measured against the SAME vendor's current models, and matched
 * to the rows pi lists. `model-tier.ts` applies the Claude Code parity gate
 * (frontier), the user's overrides and the no-catalog fallback on top. Pure:
 * pi types only. working-docs/decisions/model-tiers.md.
 *
 * The rules, per vendor (the canonical id's prefix, `alibaba/qwen3.8-27b`):
 *
 * 1. Tiny means small: under `TINY_PARAMS` total parameters (Hugging Face, else
 *    a size tag in the id), or, for a model with no published size, a
 *    nano/micro/lite/tiny name. A tag followed by an expert count
 *    (`llama-4-scout-17b-16e`) counts active parameters and is no size. A
 *    model shares its size with its twins, the same vendor's rows of the same
 *    model: same stem (the id without `-latest`, a snapshot date or a size
 *    tag) and the same release date, or one a dated snapshot of the other. An
 *    unsized alias (`voxtral-small-latest`) takes its twins' size when they
 *    agree on tiny, and their non-text output; a size tag yields to a larger
 *    measured size of an untagged twin (Bedrock's `llama-4-maverick-17b-instruct`
 *    is OpenRouter's 401B `llama-4-maverick`), unless its twins carry other
 *    tags (a size ladder released together) or it names its active size too
 *    (`qwen3.6-35b-a3b`).
 * 2. The comparison set is the vendor's current models: released within
 *    `CURRENT_WINDOW_DAYS` of its newest tool-calling, non-deprecated,
 *    text-output model, tiny excluded.
 * 3. Workhorse or cheap: when every model in the set has a known size, a model
 *    with at least `SIZE_RATIO` of the largest one's parameters is workhorse;
 *    otherwise a model whose blended price is at least `PRICE_RATIO` of the
 *    set's median price is (the median, so premium SKUs, `-pro` and `-fast`,
 *    do not set the bar). Prices are the vendor's own, from models.dev, not a
 *    gateway's promotion. A vendor with fewer than `MIN_PRICE_PEERS` current
 *    priced models has nothing to compare against: its models are cheap.
 * 4. Age: a workhorse model more than `AGE_DEMOTE_DAYS` older than the
 *    vendor's newest workhorse-class model drops to cheap. Age never makes a
 *    model tiny.
 * 5. Automatic selection skips a model that is superseded (the vendor has a
 *    newer model in the same or a higher tier within `SUPERSEDE_PRICE_BAND`
 *    of its price, and the session's provider serves it: a newer Opus
 *    supersedes the last Opus, but a newer Sonnet at half the price does not;
 *    a moving alias or the model's own dated snapshot never supersedes it),
 *    legacy (more than `LEGACY_DAYS` behind the vendor's newest model),
 *    deprecated, unable to call tools, or not a text model.
 *
 * Every constant is a ratio or a physical size, never a vendor or a dollar
 * figure, so a new vendor or a price cut needs no code change.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { type CatalogSources, loadCatalogSources, MODELS_DEV_PROVIDER, type ModelsDevModel, type OpenRouterModel } from "./model-catalog-data.ts";
import { BUILTIN_PROVIDER_POLICIES, baseModelId, DAY_MS, isMovingAlias, modelIdentity, stripSnapshotDate, vendorProfile } from "./model-policy.ts";
import { oneCodeStateDir } from "./paths.ts";

export const TINY_PARAMS = 40e9;
export const SIZE_RATIO = 0.5;
export const PRICE_RATIO = 0.3;
export const CURRENT_WINDOW_DAYS = 182;
export const AGE_DEMOTE_DAYS = 365;
export const LEGACY_DAYS = 730;
/** A successor's price band against the model it supersedes: the same product class, not a cheaper sibling. */
export const SUPERSEDE_PRICE_BAND = [0.6, 1.5] as const;
/** Fewer current priced models than this and a vendor has no price to compare against. */
export const MIN_PRICE_PEERS = 3;

export type CatalogTier = "workhorse" | "cheap" | "tiny";

export interface CatalogModel {
	/** The vendor's own `vendor/id`, or a gateway's `vendor/id` for a model no vendor row names. */
	id: string;
	vendor: string;
	/** A gateway row no vendor row names: placed against its vendor's models, never part of the comparison. */
	derived: boolean;
	released?: number;
	deprecated: boolean;
	/** False only when a catalog says the model cannot call tools. */
	tools: boolean;
	/** Outputs images, audio or the like: never compared or picked. */
	nonTextOutput: boolean;
	/** Blended USD per million tokens, 3 input to 1 output. */
	price?: number;
	params?: number;
	tier: CatalogTier;
	/** Why the tier, in words, for the catalog snapshot and /doctor. */
	reason: string;
	/**
	 * Newer models of the same vendor, same or higher tier, in the same price
	 * band, newest first. Automatic selection skips this model where one of
	 * them is served (`autoSelectSkipReason`).
	 */
	successors: string[];
	legacy: boolean;
}

const TIER_RANK: Record<CatalogTier, number> = { workhorse: 0, cheap: 1, tiny: 2 };
const SMALL_WORD = /(?:^|[-/.])(?:nano|micro|lite|tiny)(?:[-/.:]|$)/i;
/** Any size tag: `27b`, `1.5b`, Gemma's effective-size `e2b`, and an MoE's active `17b`. */
const ANY_SIZE_TAG = /(?:^|[-/.])e?(\d+(?:\.\d+)?)b(?=[-/.:]|$)/i;
/** A size tag that names a total: not one followed by an expert count (`17b-16e`, Llama 4's active size). */
const SIZE_TAG = /(?:^|[-/.])e?(\d+(?:\.\d+)?)b(?=[-/.:]|$)(?![-/.]\d+e(?:[-/.:]|$))/i;
/** A total size tag that names the active size after it (`35b-a3b`): certainly the total. */
const TOTAL_AND_ACTIVE_TAG = /(?:^|[-/.])e?\d+(?:\.\d+)?b-a\d+(?:\.\d+)?b(?:[-/.:]|$)/i;

/** Parameters a size tag in the id names (`qwen3.8-27b` → 27e9), if any. */
export function sizeFromName(id: string): number | undefined {
	const match = id.match(SIZE_TAG);
	return match ? Number(match[1]) * 1e9 : undefined;
}

/**
 * The part of an id its aliases, snapshots and sized variants share:
 * `voxtral-small` for `voxtral-small-latest` and `voxtral-small-24b-2507`.
 */
function modelStem(rest: string): string {
	const id = stripSnapshotDate(rest.toLowerCase().replace(/-latest$/, ""));
	const tag = ANY_SIZE_TAG.exec(id);
	return tag && tag.index > 0 ? id.slice(0, tag.index) : id;
}

/** Whether a model with no published size is small by name. */
export function smallByName(id: string): boolean {
	return SMALL_WORD.test(id);
}

const blended = (input: number | undefined, output: number | undefined): number | undefined =>
	input !== undefined && output !== undefined && input >= 0 && output >= 0 && input + output > 0 ? (3 * input + output) / 4 : undefined;

function formatParams(params: number): string {
	return params >= 1e12 ? `${(params / 1e12).toFixed(1)}T` : `${Math.round(params / 1e9)}B`;
}

const dateOf = (value: string | undefined): number | undefined => {
	const time = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(time) ? undefined : time;
};

interface Draft extends Omit<CatalogModel, "tier" | "reason" | "legacy"> {
	/** The vendor's identity profile: `zhipuai` and `z-ai` are one vendor. */
	group: string;
	/** The id without its vendor, lowercase. */
	rest: string;
	/** `params` is a Hugging Face count, not a size tag. */
	measured: boolean;
	/** The twin whose size this model took (rule 1). */
	sizeFrom?: string;
	tier?: CatalogTier;
	reason?: string;
	legacy?: boolean;
}

export interface CatalogIndex {
	/** Canonical id → model. */
	models: Map<string, CatalogModel>;
	/** `vendorProfile|id` (lowercase) → canonical id, for rows models.dev lists under no provider pi uses. */
	byVendorId: Map<string, string>;
	/** `provider/id` on models.dev → canonical id. */
	byProviderRow: Map<string, string>;
	/** A bare model id (`glm-5.3`) → the one canonical id that ends in it; null when two vendors share it. */
	byBareId: Map<string, string | null>;
	fetchedAt: string;
}

/** Build the index from the three payloads (memoized per sources object). */
export function buildCatalogIndex(sources: CatalogSources): CatalogIndex {
	const cached = indexMemo.get(sources);
	if (cached) return cached;
	const modelsDev = sources.modelsDev.payload;
	const counts = sources.huggingFace.payload;

	// A vendor is any provider a canonical id names; only its own rows are vendor rows.
	const vendors = new Set<string>();
	for (const provider of Object.values(modelsDev)) {
		for (const row of Object.values(provider.models)) {
			const vendor = row.canonical_model_id?.split("/")[0];
			if (vendor) vendors.add(vendor);
		}
	}
	// A nested canonical id (`nvidia/moonshotai/kimi-k2.6`) is a host's copy of
	// another vendor's model: such rows fall through to the vendor's own id.
	// A gateway row no vendor row names (`openrouter` `z-ai/glm-5.3-prime`) keys
	// on its own `vendor/id`, placed against that vendor's models.
	const gateways = new Set(
		Object.entries(BUILTIN_PROVIDER_POLICIES)
			.filter(([, policy]) => policy.kind === "gateway")
			.map(([provider]) => MODELS_DEV_PROVIDER[provider] ?? provider),
	);
	const canonicalOf = (provider: string, id: string, row: ModelsDevModel): string | undefined => {
		const canonical =
			row.canonical_model_id ?? (vendors.has(provider) ? `${provider}/${id}` : gateways.has(provider) && id.split("/").length === 2 ? id : undefined);
		return canonical && canonical.indexOf("/") === canonical.lastIndexOf("/") ? canonical : undefined;
	};

	const byProviderRow = new Map<string, string>();
	const refs = new Map<string, ModelsDevModel[]>();
	for (const [provider, { models }] of Object.entries(modelsDev)) {
		for (const [id, row] of Object.entries(models)) {
			const canonical = canonicalOf(provider, id, row);
			if (!canonical) continue;
			byProviderRow.set(`${provider}/${id}`, canonical);
			const list = refs.get(canonical);
			if (list) list.push(row);
			else refs.set(canonical, [row]);
		}
	}
	const openRouterByCanonical = new Map<string, OpenRouterModel[]>();
	for (const row of sources.openRouter.payload.data) {
		const canonical = byProviderRow.get(`openrouter/${row.id}`);
		if (!canonical) continue;
		const list = openRouterByCanonical.get(canonical);
		if (list) list.push(row);
		else openRouterByCanonical.set(canonical, [row]);
	}

	const drafts: Draft[] = [];
	for (const [canonical, rows] of refs) {
		const slash = canonical.indexOf("/");
		if (slash <= 0) continue;
		const vendor = canonical.slice(0, slash);
		const rest = canonical.slice(slash + 1);
		// The vendor's own row, unless it is a renamed alias pointing elsewhere
		// (DeepSeek's `deepseek-v4-flash` serves V4.1; OpenRouter's row of that
		// name is the April build and keeps its own date).
		const ownRow = modelsDev[vendor]?.models[rest];
		const own = ownRow && (ownRow.canonical_model_id ?? canonical) === canonical ? ownRow : undefined;
		const openRouter = openRouterByCanonical.get(canonical) ?? [];
		const any = own ?? rows[0];
		const hfCounts = openRouter.map((row) => (row.hugging_face_id ? counts[row.hugging_face_id] : undefined)).filter((n): n is number => typeof n === "number" && n > 0);
		const orPrice = openRouter
			.map((row) => blended(Number(row.pricing?.prompt) * 1e6, Number(row.pricing?.completion) * 1e6))
			.find((price) => price !== undefined && Number.isFinite(price));
		const released =
			dateOf(own?.release_date) ??
			rows.map((row) => dateOf(row.release_date)).find((time) => time !== undefined) ??
			(openRouter[0]?.created ? openRouter[0].created * 1000 : undefined);
		const outputs = [...(any.modalities?.output ?? []), ...openRouter.flatMap((row) => row.architecture?.output_modalities ?? [])];
		const toolFlag = own?.tool_call ?? rows.find((row) => row.tool_call !== undefined)?.tool_call;
		drafts.push({
			id: canonical,
			vendor,
			group: vendorProfile(vendor),
			rest: rest.toLowerCase(),
			measured: hfCounts.length > 0,
			successors: [],
			derived: !own && !rows.some((row) => row.canonical_model_id === canonical),
			released,
			deprecated: own ? own.status === "deprecated" : rows.every((row) => row.status === "deprecated"),
			tools: toolFlag ?? (openRouter.length === 0 || openRouter.some((row) => row.supported_parameters?.includes("tools"))),
			nonTextOutput: outputs.some((modality) => modality !== "text"),
			price: blended(own?.cost?.input, own?.cost?.output) ?? orPrice ?? rows.map((row) => blended(row.cost?.input, row.cost?.output)).find((p) => p !== undefined),
			params: hfCounts.length > 0 ? Math.max(...hfCounts) : sizeFromName(rest),
		});
	}

	const byVendor = new Map<string, Draft[]>();
	for (const draft of drafts) {
		const list = byVendor.get(draft.group);
		if (list) list.push(draft);
		else byVendor.set(draft.group, [draft]);
	}
	for (const list of byVendor.values()) {
		shareTwinSizes(list);
		placeVendor(list);
	}

	const models = new Map<string, CatalogModel>();
	const byVendorId = new Map<string, string>();
	const byBareId = new Map<string, string | null>();
	for (const draft of drafts) {
		const model = draft as CatalogModel;
		models.set(model.id, model);
		const rest = model.id.slice(model.vendor.length + 1).toLowerCase();
		for (const key of new Set([rest, stripSnapshotDate(rest)])) {
			const lookup = `${vendorProfile(model.vendor)}|${key}`;
			if (!byVendorId.has(lookup)) byVendorId.set(lookup, model.id);
		}
		const bare = bareId(rest);
		const prior = byBareId.get(bare);
		byBareId.set(bare, prior === undefined || prior === model.id ? model.id : null);
	}
	const index: CatalogIndex = { models, byVendorId, byProviderRow, byBareId, fetchedAt: sources.modelsDev.fetchedAt };
	indexMemo.set(sources, index);
	return index;
}
const indexMemo = new WeakMap<CatalogSources, CatalogIndex>();

/**
 * A model id reduced to the part every host spells alike: the last path
 * segment (`zai-org/GLM-5.3`, `workers-ai/@cf/zai-org/glm-5.3`), lowercase,
 * Fireworks' `5p3` read as `5.3`.
 */
export function bareId(id: string): string {
	return id.slice(id.lastIndexOf("/") + 1).toLowerCase().replace(/(\d)p(\d)/g, "$1.$2");
}

const isTiny = (draft: Draft): boolean =>
	draft.params !== undefined ? draft.params < TINY_PARAMS : smallByName(draft.id.slice(draft.vendor.length + 1));
const isLive = (draft: Draft): boolean => draft.tools && !draft.deprecated && !draft.nonTextOutput && draft.released !== undefined;
/** Live and a vendor's own model: what sets the comparison and can supersede. */
const isReference = (draft: Draft): boolean => isLive(draft) && !draft.derived;

/**
 * Rule 1's twins, in place for one vendor: a size tag yields to a larger
 * measured size of an untagged twin (or one with the same tag), and an
 * unsized model takes its twins' size when they agree on tiny, and their
 * non-text output.
 */
function shareTwinSizes(list: Draft[]): void {
	const byStem = new Map<string, Draft[]>();
	for (const draft of list) {
		const stem = modelStem(draft.rest);
		const group = byStem.get(stem);
		if (group) group.push(draft);
		else byStem.set(stem, [draft]);
	}
	const twinsOf = (draft: Draft): Draft[] =>
		(byStem.get(modelStem(draft.rest)) ?? []).filter(
			(other) =>
				other !== draft &&
				((draft.released !== undefined && other.released === draft.released) ||
					stripSnapshotDate(other.rest) === draft.rest ||
					stripSnapshotDate(draft.rest) === other.rest),
		);
	const adopt = (draft: Draft, from: Draft[]): void => {
		const source = from.reduce((a, b) => (b.params! > a.params! ? b : a));
		draft.params = source.params;
		draft.sizeFrom = source.id;
	};

	for (const draft of list) {
		const tag = sizeFromName(draft.rest);
		if (draft.measured || tag === undefined || TOTAL_AND_ACTIVE_TAG.test(draft.rest)) continue;
		const twins = twinsOf(draft);
		// A size ladder released together: each tag is its own model's total.
		if (twins.some((twin) => (sizeFromName(twin.rest) ?? tag) !== tag)) continue;
		const measured = twins.filter((twin) => twin.measured && twin.params! > tag);
		if (measured.length > 0) adopt(draft, measured);
	}
	for (const draft of list) {
		if (draft.params !== undefined) continue;
		const twins = twinsOf(draft);
		if (twins.some((twin) => twin.nonTextOutput)) draft.nonTextOutput = true;
		const sized = twins.filter((twin) => twin.params !== undefined);
		if (sized.length > 0 && new Set(sized.map((twin) => twin.params! < TINY_PARAMS)).size === 1) adopt(draft, sized);
	}
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Rules 1–5 for one vendor's models, in place. */
function placeVendor(list: Draft[]): void {
	const live = list.filter(isReference);
	const newest = Math.max(...live.map((draft) => draft.released!));
	const current = live.filter((draft) => newest - draft.released! <= CURRENT_WINDOW_DAYS * DAY_MS && !isTiny(draft));
	const sizeBasis = current.length > 0 && current.every((draft) => draft.params !== undefined);
	const maxParams = sizeBasis ? Math.max(...current.map((draft) => draft.params!)) : undefined;
	const prices = current.map((draft) => draft.price).filter((price): price is number => price !== undefined && price > 0);
	const referencePrice = prices.length >= MIN_PRICE_PEERS ? median(prices) : undefined;
	const vendor = (list.find((draft) => !draft.derived) ?? list[0])?.vendor ?? "";

	const size = (draft: Draft): string => `${formatParams(draft.params!)} parameters${draft.sizeFrom ? ` (as ${draft.sizeFrom})` : ""}`;
	for (const draft of list) {
		if (isTiny(draft)) {
			draft.tier = "tiny";
			draft.reason = draft.params !== undefined ? `${size(draft)}, under ${formatParams(TINY_PARAMS)}` : "a small-model name, size unpublished";
		} else if (maxParams !== undefined && draft.params !== undefined) {
			const ratio = draft.params / maxParams;
			draft.tier = ratio >= SIZE_RATIO ? "workhorse" : "cheap";
			draft.reason = `${size(draft)}, ${ratio.toFixed(2)} of ${vendor}'s largest current model (${formatParams(maxParams)})`;
		} else if (referencePrice !== undefined && draft.price !== undefined) {
			const ratio = draft.price / referencePrice;
			draft.tier = ratio >= PRICE_RATIO ? "workhorse" : "cheap";
			draft.reason = `$${draft.price.toFixed(2)}/M blended, ${ratio.toFixed(2)} of ${vendor}'s median current price ($${referencePrice.toFixed(2)})`;
		} else {
			draft.tier = "cheap";
			draft.reason = prices.length < MIN_PRICE_PEERS ? `${vendor} has too few current priced models to compare against` : "no size or price to compare";
		}
	}

	// Age: within the vendor's workhorse class only (rule 4).
	const workhorseNewest = Math.max(...live.filter((draft) => draft.tier === "workhorse").map((draft) => draft.released!));
	for (const draft of list) {
		if (draft.tier === "workhorse" && draft.released !== undefined && workhorseNewest - draft.released > AGE_DEMOTE_DAYS * DAY_MS) {
			draft.tier = "cheap";
			draft.reason += `; over a year older than ${vendor}'s newest model of its size class`;
		}
		draft.legacy = draft.released !== undefined && Number.isFinite(newest) && newest - draft.released > LEGACY_DAYS * DAY_MS;
	}

	// Supersession (rule 5): every qualifying successor, newest first; selection
	// skips the model only where one is served. A moving alias names some other
	// model, and a dated snapshot is the model it dates.
	const successors = live.filter((draft) => !draft.legacy && !isMovingAlias(draft.rest)).sort((a, b) => b.released! - a.released!);
	for (const draft of list) {
		if (draft.released === undefined || draft.price === undefined) continue;
		draft.successors = successors
			.filter(
				(other) =>
					other !== draft &&
					other.released! > draft.released! &&
					stripSnapshotDate(other.rest) !== draft.rest &&
					TIER_RANK[other.tier!] <= TIER_RANK[draft.tier!] &&
					other.price !== undefined &&
					other.price >= draft.price! * SUPERSEDE_PRICE_BAND[0] &&
					other.price <= draft.price! * SUPERSEDE_PRICE_BAND[1],
			)
			.map((other) => other.id);
	}
}

/**
 * Whether automatic selection may pick this model at all (rule 5). `served`
 * holds the catalog ids the session's contained models serve
 * (`model-tier.ts servedCatalogIds`): only a served successor supersedes.
 */
export function autoSelectable(model: CatalogModel, served: ReadonlySet<string>): boolean {
	return autoSelectSkipReason(model, served) === undefined;
}

/** Why automatic selection skips the model, in words; undefined when it does not. */
export function autoSelectSkipReason(model: CatalogModel, served: ReadonlySet<string>): string | undefined {
	const successor = model.successors.find((id) => served.has(id));
	if (successor) return `superseded by ${successor}, which this provider serves`;
	if (model.legacy) return "over two years older than its vendor's newest model";
	if (model.deprecated) return "deprecated";
	if (!model.tools) return "cannot call tools";
	if (model.nonTextOutput) return "not a text model";
	return undefined;
}

/** The index over the sources in use (bundled or refreshed, whichever is newer). */
export function currentCatalog(): CatalogIndex {
	return buildCatalogIndex(loadCatalogSources(oneCodeStateDir()));
}

/**
 * The catalog model a pi row serves, or undefined. A built-in provider's row
 * is looked up on models.dev under its provider and followed to its canonical
 * id; a row models.dev does not list (OpenAI Codex, Azure) is matched by
 * vendor and id through its identity; a host that serves open models under
 * their own names (Together, Fireworks, the Qwen plans) by the bare id, when
 * exactly one vendor has it. A custom provider is never matched: its ids can
 * name anything.
 */
export function catalogModelFor(model: { provider: string; id: string }, index: CatalogIndex = currentCatalog()): CatalogModel | undefined {
	if (!(model.provider in BUILTIN_PROVIDER_POLICIES)) return undefined;
	const provider = MODELS_DEV_PROVIDER[model.provider] ?? model.provider;
	const listed = index.byProviderRow.get(`${provider}/${model.id}`) ?? index.byProviderRow.get(`${provider}/${baseModelId(model.id)}`);
	if (listed) return index.models.get(listed);
	const identity = modelIdentity(model as Model<Api>);
	if (identity.confidence !== "opaque" && identity.profile) {
		const id = baseModelId(identity.normalizedId).toLowerCase();
		const canonical = index.byVendorId.get(`${identity.profile}|${id}`) ?? index.byVendorId.get(`${identity.profile}|${stripSnapshotDate(id)}`);
		if (canonical) return index.models.get(canonical);
	}
	const bare = bareId(baseModelId(model.id));
	const canonical = index.byBareId.get(bare) ?? index.byBareId.get(stripSnapshotDate(bare));
	return canonical ? index.models.get(canonical) : undefined;
}

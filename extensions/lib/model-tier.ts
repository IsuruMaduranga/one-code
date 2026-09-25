/**
 * Which system-prompt register + tool surface the active model gets. Claude Code
 * ships a capability-tiered prompt — a terse one for Opus, a much longer, more
 * explicit one for Sonnet/Haiku (Anthropic removed 80%+ of the prompt for
 * Claude-5-gen models with no measured loss). One Code serves every provider, so
 * its non-frontier audience extends *below* Haiku; a single lean prompt
 * under-instructs it. This module maps a model to one of FOUR tiers:
 *
 *   frontier   Opus/Fable only — terse register (cc-opus), bash covers search
 *   workhorse  Sonnet-class + capable third-party — verbose register (cc-sonnet)
 *   cheap      Haiku-class — verbose register (cc-haiku), matches CC exactly
 *   tiny       sub-Haiku models — verbose + weak-model scaffolding + grep/find/ls
 *
 * `extensions/system-prompt` picks the prompt text from the tier;
 * `extensions/search-tools` activates grep/find/ls only for `tiny`. Rationale +
 * rejected alternatives: `working-docs/decisions/model-tiers.md`.
 *
 * The classification obeys the repo convention against id-substring matching as
 * the LEAD signal (see `auto-mode/model-select.ts`): frontier is a version-gated
 * first-party Anthropic allowlist. Below it, a curated anchor map or the name
 * class sets the tier and the model's GENERATION (models.dev release dates,
 * `model-facts.ts`) demotes it — price is not consulted once facts are known, so
 * an unpriced but current flagship on a hosted catalog keeps the workhorse
 * register. Rows without facts fall back to the name-class cap, the "pro"-class
 * hint and the absolute price floor, where unpriced/opaque means maximum
 * scaffolding. The Artificial Analysis index never sets a register; it feeds the
 * optional measured SELECTION floor (`capability-index.ts`) — see
 * `classifyModelTier` and `working-docs/decisions/model-tiers.md`.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	capabilityFloor,
	type CapabilitySnapshot,
	type FloorRole,
	loadCapabilitySnapshot,
	referenceScore,
	REGISTER_CHEAP_RATIO,
	REGISTER_TINY_RATIO,
	scoreFor,
} from "./capability-index.ts";
import { isPriorGeneration, lacksToolCalls, modelGeneration } from "./model-facts.ts";
import {
	BUILTIN_PROVIDER_POLICIES,
	baseModelId,
	isDatedDuplicate,
	modelIdentity,
	modelsContainedToSession,
	modelSpec,
	pricedInput,
	supportsImageInput,
} from "./model-policy.ts";
import { oneCodeStateDir } from "./paths.ts";

export type PromptTier = "frontier" | "workhorse" | "cheap" | "tiny";

/** More-scaffolded = higher rank. Used to combine the price floor with the name cap. */
const TIER_RANK: Record<PromptTier, number> = { frontier: 0, workhorse: 1, cheap: 2, tiny: 3 };
function moreScaffolded(a: PromptTier, b: PromptTier): PromptTier {
	return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Cost-preference order for automatic secondary-model selection: cheapest
 * *capable* tier first, stepping UP only when a tier is empty. `tiny` is absent
 * on purpose — automatic selection never lands there (see
 * `economicalContainedCandidates`).
 */
const COST_PREFERENCE: Record<Exclude<PromptTier, "tiny">, number> = { cheap: 0, workhorse: 1, frontier: 2 };

/**
 * `CC_PROMPT_TIER=frontier|workhorse|cheap|tiny` forces a register; `auto`/unset
 * classifies. Env only — a project must not be able to downgrade its own
 * scaffolding, the same reasoning that keeps `autoMode` out of project settings.
 */
export function tierOverride(env: NodeJS.ProcessEnv = process.env): PromptTier | undefined {
	const raw = env.CC_PROMPT_TIER?.trim().toLowerCase();
	return raw === "frontier" || raw === "workhorse" || raw === "cheap" || raw === "tiny" ? raw : undefined;
}

/**
 * Anthropic first-party frontier gate: Opus/Fable ≥ 4.7 ONLY (Sonnet is
 * deliberately excluded — CC gives only Opus the terse register, and the
 * intelligence index would wrongly promote flash models to frontier at max
 * effort; see `working-docs/decisions/model-tiers.md`). Adapted from pi-ai's
 * `defaultSupportsToolReferences` — never Haiku, and the `length < 8` guard stops
 * a dated suffix (`claude-opus-4-8-20251101`) being read as the minor version.
 * Version parse, not price: `claude-opus-4-1` ($15/M) costs more than
 * `opus-4-8`/`opus-5` ($5/M), so cost ranking would misclassify it.
 */
function isAnthropicFrontier(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = parseClaudeVersion(model.id);
	if (!version) return false;
	if (version.family === "sonnet") return false; // Sonnet is workhorse, never frontier
	return version.major > 4 || (version.major === 4 && version.minor >= 7);
}

/**
 * OpenAI first-party frontier gate: the GPT-6 Astra and Sol lines and later
 * majors (`gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol-pro`), served by OpenAI
 * itself (the `openai`, `openai-codex` and `azure-openai-responses` providers).
 * GPT-5.x Sol and Terra, and every Luna, stay below it (decided 2026-09-25:
 * Astra and Sol 6 are the OpenAI models comparable to Fable and Opus 5). A
 * gateway-proxied copy can't be verified, the same rule as Claude above.
 */
function isOpenAIFrontier(model: Model<Api>): boolean {
	const policy = BUILTIN_PROVIDER_POLICIES[model.provider];
	if (policy?.kind !== "direct" || policy.profile !== "openai") return false;
	const match = model.id.match(/^gpt-(\d+)(?:\.\d+)?-(?:astra|sol)(?:-|$)/);
	return match !== null && Number(match[1]) >= 6;
}

/**
 * Structural parse of a first-party Claude model id (`claude-opus-4-8`,
 * `claude-sonnet-5`, `claude-opus-4-5-20251101`): family, major, minor. A
 * dated suffix is never read as the minor version (the `length < 8` guard).
 * Undefined for anything else. Shared by the frontier gate here and the
 * tool-reference gate in `deferred.ts`.
 */
export function parseClaudeVersion(id: string): { family: "opus" | "sonnet" | "fable"; major: number; minor: number } | undefined {
	const version = id.match(/^claude-(opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return undefined;
	return {
		family: version[1] as "opus" | "sonnet" | "fable",
		major: Number(version[2]),
		minor: version[3] && version[3].length < 8 ? Number(version[3]) : 0,
	};
}

/**
 * Curated anchor map for well-known third-party families, checked in order
 * (specific before general). A vetted allowlist — distinct from heuristic
 * substring matching — that fixes cases where price/name alone misroute a
 * flagship, and encodes the ratified overrides (GPT-5-mini→cheap,
 * GPT-5.6/6-Luna→cheap, GPT-5.x-codex-spark→cheap; the GPT-5-full→workhorse one
 * was retired 2026-09-11 once the coding index contradicted it). A match here is authoritative for the
 * name class (the human already accounted for the name and its generation), so
 * it wins outright — only the two-generations-behind rule still demotes it to
 * tiny (`classifyModelTier`). Shrink it whenever the catalog-wide snapshot
 * (`test/unit/model-tier-catalog.test.ts`) shows the generic rules reproduce an
 * entry; refresh the reference table with `tools/model-tiers/model_tiers.py`.
 */
const ANCHOR_MAP: Array<[RegExp, PromptTier]> = [
	// OpenAI GPT-5 family — order matters: variant suffixes before the generic.
	[/(?:^|[-/.])gpt-5[.\d]*-?nano/i, "tiny"],
	[/(?:^|[-/.])gpt-5[.\d]*-?mini/i, "cheap"], // override: price would say tiny
	[/(?:^|[-/.])gpt-[56][.\d]*-?luna/i, "cheap"], // override: OpenAI's cheap line despite a high benchmark (GPT-6 Luna: $0.10/$0.50)
	// Spark: OpenAI's fast/small Codex line; no Artificial Analysis row either way, so it
	// is placed with the other lean lines rather than inheriting the family's workhorse
	// name class (2026-09-11 — it had been the cheapest "workhorse" on every Codex session).
	[/(?:^|[-/.])gpt-5[.\d]*-codex-spark/i, "cheap"],
	// No blanket `gpt-5 → workhorse` anchor any more (2026-09-11): it existed to guard
	// the base GPT-5 variant against a benchmark collision, but the coding index now
	// reads base gpt-5 at 37.8 and gpt-5.1 at 49.4 — the anchor was the lie, not the
	// score. Unsuffixed gpt-5.x rows take the name class (workhorse) and let their
	// generation and measured score demote them.
	[/(?:^|[-/.])o[34](?:[-/.]|$)/i, "cheap"], // o3, o3-pro, o4-mini
	[/(?:^|[-/.])gpt-4/i, "tiny"], // gpt-4o, gpt-4.1, gpt-4-turbo — prior generation
	// Anthropic reaching this path is gateway-proxied (first-party handled above);
	// a proxied model can't be version-verified for frontier, so Opus/Sonnet → workhorse.
	[/claude[-/.].*haiku/i, "cheap"],
	[/claude[-/.].*(?:sonnet|opus)/i, "workhorse"],
	// Google Gemini needs no anchor: `lite` is a tiny name, `pro` a capable one, and
	// bare flash is cheap by name class (generation decides 2.5 vs 3.x) — removed
	// 2026-09-10 once the catalog-wide snapshot showed the generic rules reproduce it.
	// Other capable flagships whose price may dip below the workhorse floor.
	[/(?:^|[-/.])grok-4/i, "workhorse"],
	// DeepSeek — priced ~10x below the vendors the price floors were calibrated
	// on, so on the no-facts path the floors alone put every V4 Flash row in tiny
	// and let R1-0528 ($0.50, on the cheap boundary) win automatic selection
	// (2026-09-10). With release-date facts the generic rules reproduce the V4
	// rows; the block stays for rows models.dev does not know yet (V4.1 Flash on
	// its release day) and for R1/V3.x/`deepseek-chat`, which a one-generation
	// demotion would leave at cheap rather than tiny.
	[/(?:^|[-/.])deepseek[-.]v4[.\d]*-flash/i, "cheap"],
	[/(?:^|[-/.])deepseek[-.]v4[.\d]*-pro/i, "workhorse"],
	[/(?:^|[-/.])deepseek[-.](?:r1|chat|v3)(?:[-.:]|$)/i, "tiny"], // `deepseek.v3` is Bedrock's spelling
];

function anchorTier(id: string): PromptTier | undefined {
	const base = baseModelId(id);
	for (const [pattern, tier] of ANCHOR_MAP) if (pattern.test(base)) return tier;
	return undefined;
}

/**
 * Name-class CAP: a lean/fast model class raises scaffolding (never lowers it).
 * Delimited tokens — a bare `/mini/` matches inside "geMINI", dragging every
 * Gemini model to cheap. `\d+b` catches size tags (8b, 70b) as the strongest
 * (tiny) signal. Returns the ceiling tier the name justifies.
 */
const TINY_NAME_HINT = /(?:^|[-/.])(?:nano|micro|lite|tiny|xs|distill|instant|\d+b)(?:[-/.]|$)/i;
const CHEAP_NAME_HINT = /(?:^|[-/.])(?:flash|mini|small|air)(?:[-/.]|$)/i;
function nameClassCap(id: string): PromptTier {
	const base = baseModelId(id); // `flash:batch` must still read as flash
	if (TINY_NAME_HINT.test(base)) return "tiny";
	if (CHEAP_NAME_HINT.test(base)) return "cheap";
	return "workhorse";
}

/**
 * A capable-class name marks the flagship of a family (deepseek-v4-pro,
 * qwen3-max) — keeps a cheap or unpriced flagship at workhorse rather than being
 * dragged down by the price floor. Delimited so it fires on `-pro`/`max-` but not
 * `prometheus`/`improved`. Only applies when no lean-name cap contradicts it.
 */
const CAPABLE_NAME_HINT = /(?:^|[-/.])(?:pro|max|ultra|large)(?:[-/.]|$)/i;

/** Input price (USD/1M) floors: capable flagships sit ≥ $1/M; mini/flash under $0.5. */
const WORKHORSE_MIN_INPUT_COST = 1.0;
const CHEAP_MIN_INPUT_COST = 0.5;

/** Price/containment floor for an unanchored third-party model, biased low. */
function priceFloorTier(model: Model<Api>): PromptTier {
	if (modelIdentity(model).confidence === "opaque") return "tiny"; // local/self-hosted → max scaffolding
	const price = pricedInput(model);
	if (price === undefined) return "tiny"; // unpriced/unknown → maximum scaffolding
	if (price >= WORKHORSE_MIN_INPUT_COST) return "workhorse";
	if (price >= CHEAP_MIN_INPUT_COST) return "cheap";
	return "tiny";
}

/** One step more scaffolded: workhorse → cheap → tiny (frontier never enters). */
function demote(tier: PromptTier): PromptTier {
	return tier === "workhorse" ? "cheap" : "tiny";
}

export interface TierClassification {
	tier: PromptTier;
	/** Which rule decided, for the catalog-wide snapshot and the doctor report. */
	reason: string;
}

/**
 * The tier and the rule that produced it. `resolveModelTier` is the plain form.
 *
 * Non-frontier, non-first-party models are classified in this order:
 *   1. the curated anchor map (verifiable providers only) sets the name-class tier;
 *   2. otherwise the name class does (pro/max/unmarked → workhorse, flash/mini →
 *      cheap, nano/lite/size-tag → tiny) — when the model has release-date facts.
 *      Then its GENERATION demotes: one tier when it trails its vendor family's
 *      newest release by more than a year (name-class path only — an anchor is
 *      human-reviewed), to tiny beyond two for both. Price is not
 *      consulted: it encodes neither capability nor generation (an old model
 *      keeps its old price), and absolute dollar floors misread every vendor
 *      priced below the US majors — `model-facts.ts`.
 *   3. without facts, the pre-facts heuristics: name-class cap, the capable-name
 *      hint (verifiable providers only), and the absolute price floor, combined
 *      as the more scaffolded of the two.
 */
export function classifyModelTier(model: Model<Api> | undefined, env: NodeJS.ProcessEnv = process.env): TierClassification {
	const named = classifyByName(model, env);
	// The measured cap: a name can only lie UPWARD about capability that a score
	// then corrects (gpt-5 at 37.8 is not a Sonnet-class model whatever its
	// anchor said), and downward it is already the safer register, so the score
	// only ever adds scaffolding. Frontier (a first-party allowlist), Anthropic
	// first-party (the scale's own anchors), a forced tier and an already-tiny
	// row are left alone.
	if (!model || named.reason === "CC_PROMPT_TIER" || named.tier === "frontier" || named.tier === "tiny" || model.provider === "anthropic") return named;
	const measured = measuredRegisterCap(model);
	if (!measured) return named;
	const tier = moreScaffolded(named.tier, measured.cap);
	if (tier === named.tier) return named;
	return { tier, reason: `${named.reason} · measured coding ${measured.coding} below the ${measured.cap} line (${measured.threshold.toFixed(1)})` };
}

/**
 * The register cap the Artificial Analysis snapshot supports for a model, if
 * any: `cheap` below REGISTER_CHEAP_RATIO × Sonnet 5, `tiny` below
 * REGISTER_TINY_RATIO × Sonnet 5, judged on the default (thinking-on) variant.
 * Undefined without a snapshot, a confirmed score, or a reference score — the
 * name-led tier then stands, as before the snapshot existed.
 */
export function measuredRegisterCap(model: Model<Api>): { cap: "cheap" | "tiny"; coding: number; threshold: number } | undefined {
	const snapshot = currentCapabilitySnapshot();
	if (!snapshot) return undefined;
	const score = scoreFor(snapshot, model, "default");
	const reference = referenceScore(snapshot, "default");
	if (!score || !reference) return undefined;
	const tinyLine = reference.coding * REGISTER_TINY_RATIO;
	if (score.coding < tinyLine) return { cap: "tiny", coding: score.coding, threshold: tinyLine };
	const cheapLine = reference.coding * REGISTER_CHEAP_RATIO;
	if (score.coding < cheapLine) return { cap: "cheap", coding: score.coding, threshold: cheapLine };
	return undefined;
}

/** The name-led classification (anchors, name class, generation, price) before the measured cap. */
function classifyByName(model: Model<Api> | undefined, env: NodeJS.ProcessEnv): TierClassification {
	const forced = tierOverride(env);
	if (forced) return { tier: forced, reason: "CC_PROMPT_TIER" };
	if (!model) return { tier: "tiny", reason: "no model" }; // unknown model → maximum scaffolding

	if (isAnthropicFrontier(model)) return { tier: "frontier", reason: "anthropic frontier allowlist" };
	if (isOpenAIFrontier(model)) return { tier: "frontier", reason: "openai frontier allowlist" };
	if (model.provider === "anthropic") {
		// First-party non-frontier: Haiku → cheap; Sonnet / Opus 4.1–4.6 / other →
		// workhorse. Version-named ids already encode generation, and the tiny
		// register would be wrong for a still-sold Opus, so no date demotion here;
		// automatic selection still skips prior-generation rows.
		return model.id.includes("haiku") ? { tier: "cheap", reason: "anthropic haiku" } : { tier: "workhorse", reason: "anthropic first-party" };
	}

	// A curated anchor is authoritative for the NAME CLASS — but only for a
	// verifiable provider. A local/self-hosted (opaque) provider's id could be
	// anything, so it must NOT reach the anchor map (a model aliased
	// "claude-sonnet-5" on ollama is not the real thing) nor the capable-name
	// hint; it falls through to the generic heuristics, where the opaque check
	// biases it to maximum scaffolding.
	const opaque = modelIdentity(model).confidence === "opaque";
	const anchor = opaque ? undefined : anchorTier(model.id);

	const generation = opaque ? undefined : modelGeneration(model);
	if (generation !== undefined) {
		const nameTier = anchor ?? nameClassCap(model.id); // never frontier: anchors and name classes stop at workhorse
		if (generation === "ancient") return { tier: "tiny", reason: `${anchor ? "anchor" : "name class"} · two generations behind` };
		// A curated anchor already weighed the model's generation (it is reviewed
		// against the catalog diff), so only the name-class path is demoted here.
		if (generation === "prior" && !anchor) return { tier: demote(nameTier), reason: "name class · one generation behind" };
		return { tier: nameTier, reason: anchor ? "anchor" : "name class" };
	}
	if (anchor) return { tier: anchor, reason: "anchor" };

	const cap = nameClassCap(model.id);
	// A "pro"/"max"-class name keeps a cheap/unpriced flagship at workhorse; a lean
	// name (cap below workhorse) always wins, so only consult it when cap allows.
	if (!opaque && cap === "workhorse" && CAPABLE_NAME_HINT.test(baseModelId(model.id))) return { tier: "workhorse", reason: "capable name, no facts" };
	const floor = priceFloorTier(model);
	const tier = moreScaffolded(floor, cap);
	return { tier, reason: opaque ? "opaque provider" : pricedInput(model) === undefined ? "unpriced, no facts" : "price floor, no facts" };
}

export function resolveModelTier(model: Model<Api> | undefined, env: NodeJS.ProcessEnv = process.env): PromptTier {
	return classifyModelTier(model, env).tier;
}

const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the session model gets the task tools (`task_create` and family),
 * Claude Code's model gate for a foreground session: its current models run
 * without a task list, which `CLAUDE_CODE_ENABLE_TODO_TOOLS` turns back on
 * (findings §31). Off for the frontier tier and first-party Sonnet 5 or later;
 * on for everything else, including an unknown model (Claude Code keeps the
 * tools for a model it does not recognise). Claude Code also turns them on in
 * a backgrounded session, which One Code does not have.
 */
export function taskToolsEnabled(model: Model<Api> | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	if (TRUTHY_ENV.has(env.CLAUDE_CODE_ENABLE_TODO_TOOLS?.trim().toLowerCase() ?? "")) return true;
	if (!model) return true;
	if (resolveModelTier(model, env) === "frontier") return false;
	if (model.provider !== "anthropic") return true;
	const version = parseClaudeVersion(model.id);
	return !(version?.family === "sonnet" && version.major >= 5);
}


/**
 * The ordered candidate chain for an automatic *secondary* model — the same
 * mechanism the auto-mode classifier and subagents both consume, so a session
 * screens and delegates on one economical same-provider model.
 *
 * The chain is:
 *   - **contained** to the session's provider (and route/family on gateways):
 *     the classifier reads the user's prompts + CLAUDE.md and subagents inherit
 *     the parent transcript, so leaving the session's provider silently is a
 *     privacy leak — only an explicit setting may cross (see the two model-select
 *     modules);
 *   - never `tiny`: a sub-Haiku model is a weak security boundary and a weak
 *     coding worker, so automatic selection stops at `cheap` and steps UP
 *     (cheap → workhorse → frontier), never down. This is the capability floor
 *     `working-docs/decisions/auto-mode.md` recorded as still-missing;
 *   - current generation only, and able to call tools: with models.dev facts
 *     known (`model-facts.ts`), a row more than a year behind its vendor family's
 *     newest release is excluded whatever its price or name, as is a row marked
 *     as lacking tool calls. Rows without facts pass this gate unchanged;
 *   - priced only: an unpriced/opaque row is treated as `tiny` by
 *     `resolveModelTier`, so this excludes it too. On a provider with no usable
 *     prices the chain is empty and callers degrade to the session model
 *     (correct, merely not cheap).
 *
 * Sorted by cost preference (cheapest capable *tier* first) then input price, so
 * the head is "the cheapest capable model this provider offers." The session
 * model may appear in the chain; the budget-gated `cheaperContainedCandidates`
 * drops it. Budget ceilings and strictly-cheaper-than-session are caller policy —
 * this function ranks, it does not gate. A caller that already computed the
 * containment set may pass it as `contained` to skip the O(catalog) recompute.
 *
 * `requireImageInput` (default false) drops every candidate that cannot take
 * image input — the modality gate a subagent selection sets when the session
 * model is image-capable, so a delegated worker can still read an image or PDF
 * the session may feed it. The classifier and the readers leave it false: the
 * classifier renders the transcript to text and the readers strip images, so
 * neither ever sends one. See `working-docs/decisions/model-policy.md`.
 */
export function economicalContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	contained?: Model<Api>[],
	requireImageInput = false,
): Model<Api>[] {
	const pool = contained ?? modelsContainedToSession(available, sessionModel);
	return pool
		// Modality gate: when the session works with images/PDFs a subagent may
		// need to read, a text-only worker cannot serve — drop it before ranking.
		.filter((model) => !requireImageInput || supportsImageInput(model))
		// A dated snapshot whose undated alias is also listed is the same model
		// twice; rank the alias so every automatic pick (classifier, subagent,
		// reader, presets) names the model the way the user sees it in /model.
		.filter((model) => !isDatedDuplicate(model, pool))
		// Facts, when known: a model one generation behind its family is never
		// picked automatically however it prices (the R1-over-V4-Flash incident),
		// and a subagent or screener must be able to call tools at all.
		.filter((model) => !isPriorGeneration(model) && !lacksToolCalls(model))
		// Classify by the model's INTRINSIC tier — never `process.env`: CC_PROMPT_TIER
		// forces the *session's* prompt-scaffolding register, and honoring it here
		// would collapse every candidate to one tier and let a `tiny` model through
		// the security floor. Selection must judge each model on its own merits.
		.map((model) => ({ model, tier: resolveModelTier(model, INTRINSIC_TIER_ENV), price: pricedInput(model) }))
		.filter(
			(entry): entry is { model: Model<Api>; tier: Exclude<PromptTier, "tiny">; price: number } =>
				entry.tier !== "tiny" && entry.price !== undefined,
		)
		.sort((a, b) => COST_PREFERENCE[a.tier] - COST_PREFERENCE[b.tier] || a.price - b.price)
		.map((entry) => entry.model);
}

/** No CC_PROMPT_TIER override: automatic model *selection* always uses intrinsic tiers. */
const INTRINSIC_TIER_ENV: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

/** A model's own tier, CC_PROMPT_TIER ignored — what selection judges a candidate by. */
export function intrinsicTier(model: Model<Api>): PromptTier {
	return resolveModelTier(model, INTRINSIC_TIER_ENV);
}

/** Whether `tier` is at least as capable as `floor` (frontier ≥ workhorse ≥ cheap ≥ tiny). */
export function atLeastTier(tier: PromptTier, floor: PromptTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[floor];
}

/**
 * The budget-gated form the automatic secondary-model pickers all share: same as
 * `economicalContainedCandidates`, minus the session model itself and anything
 * dearer than it. `strict` requires *strictly* cheaper (subagents never upgrade a
 * cheap session); non-strict allows equal price (the classifier and reader
 * tolerate a same-price screener). With the session price unknown there is no
 * demonstrable saving, so `strict` yields nothing while non-strict keeps the
 * tier-ranked list. `contained` is forwarded to skip the containment recompute.
 */
export function cheaperContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	opts: { strict?: boolean; contained?: Model<Api>[]; role?: FloorRole; requireImageInput?: boolean } = {},
): Model<Api>[] {
	const sessionSpec = modelSpec(sessionModel);
	const sessionPrice = pricedInput(sessionModel);
	const cheaper = economicalContainedCandidates(available, sessionModel, opts.contained, opts.requireImageInput).filter((model) => {
		if (modelSpec(model) === sessionSpec) return false;
		if (sessionPrice === undefined) return !opts.strict;
		const price = pricedInput(model);
		return price !== undefined && (opts.strict ? price < sessionPrice : price <= sessionPrice);
	});
	return opts.role ? rankByCapability(cheaper, sessionModel, opts.role).map((entry) => entry.model) : cheaper;
}

/**
 * The weakest tier an AUTOMATIC pick may run on for a session: workhorse when
 * the session itself is workhorse or frontier (Claude Code's `min(main, sonnet)`
 * classifier rule), cheap otherwise (a cheap session has nothing cheaper and
 * capable; `tiny` is excluded upstream regardless). Shared by the auto-mode
 * classifier and the subagent default since 2026-09-11: a delegated worker
 * writes code and calls tools for many turns, and a weak one spends the saving
 * on retries — so both roles are held to one floor and, on most providers, one
 * model (working-docs/decisions/model-policy.md).
 */
export function automaticTierFloor(sessionModel: Model<Api>): PromptTier {
	const tier = intrinsicTier(sessionModel);
	return tier === "frontier" || tier === "workhorse" ? "workhorse" : "cheap";
}

/**
 * The floor-gated form the classifier and the subagent default share: the
 * cheaper contained candidates (`cheaperContainedCandidates`) that either
 * measurably reach the role's capability floor (an Artificial Analysis
 * snapshot, when one exists — `capability-index.ts`) or, unscored, sit at or
 * above `automaticTierFloor(sessionModel)` by name class. Measured failures are
 * already dropped upstream. The head is "the cheapest model this provider
 * offers that is capable enough for the session".
 */
export function capableContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	role: FloorRole,
	opts: { strict?: boolean; contained?: Model<Api>[]; requireImageInput?: boolean } = {},
): Model<Api>[] {
	const floor = automaticTierFloor(sessionModel);
	return rankedContainedCandidates(available, sessionModel, role, opts)
		.filter(({ model, measured }) => measured === "pass" || atLeastTier(intrinsicTier(model), floor))
		.map((entry) => entry.model);
}

interface RankedCandidate {
	model: Model<Api>;
	/** "pass": measurably reaches the floor; "unscored": no snapshot or no confirmed score (the caller's name-class rule decides). */
	measured: "pass" | "unscored";
}

/**
 * `cheaperContainedCandidates` with the measured verdict kept on each entry, so a
 * caller that must tell a measured pass from an unscored candidate (the
 * classifier's name-class fallback) reads it instead of recomputing it.
 */
function rankedContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	role: FloorRole,
	opts: { strict?: boolean; contained?: Model<Api>[]; requireImageInput?: boolean } = {},
): RankedCandidate[] {
	return rankByCapability(cheaperContainedCandidates(available, sessionModel, opts), sessionModel, role);
}

/**
 * The measured capability floor (`capability-index.ts`) over a tier-ranked
 * candidate list: candidates the Artificial Analysis snapshot shows reaching
 * min(session, Sonnet 5) come first, cheapest first — capability per dollar is
 * the question here, and a flash-class model that measurably matches the
 * session model should beat a dearer "workhorse"-named one. Measured failures
 * are dropped. Unscored candidates (no key, no confirmed match) follow in their
 * tier order, for the caller's name-class rule to judge. The score never admits
 * anything the tier gate already refused (tiny, prior generation, no tools).
 */
function rankByCapability(candidates: Model<Api>[], sessionModel: Model<Api>, role: FloorRole): RankedCandidate[] {
	const snapshot = currentCapabilitySnapshot();
	if (!snapshot) return candidates.map((model) => ({ model, measured: "unscored" }));
	const measured: RankedCandidate[] = [];
	const unscored: RankedCandidate[] = [];
	for (const model of candidates) {
		const verdict = capabilityFloor(snapshot, model, sessionModel, role).verdict;
		if (verdict === "pass") measured.push({ model, measured: "pass" });
		else if (verdict === "unscored") unscored.push({ model, measured: "unscored" });
	}
	const price = (entry: RankedCandidate) => pricedInput(entry.model) ?? Number.POSITIVE_INFINITY;
	return [...measured.sort((a, b) => price(a) - price(b)), ...unscored];
}

/** The cached Artificial Analysis snapshot, if a key has ever produced one (`capability-index.ts`). */
export function currentCapabilitySnapshot(): CapabilitySnapshot | undefined {
	return loadCapabilitySnapshot(oneCodeStateDir());
}

export interface EconomicalModelChoice {
	model: Model<Api>;
	via: "tier" | "session";
}

/**
 * The cheapest capable same-provider model, else the session model itself. Used
 * for low-stakes one-shot jobs over untrusted content (the web_fetch reader,
 * the recap) — the content goes to the model, so containment applies. Never
 * dearer than the session model, and never a `tiny`-tier model
 * (`economicalContainedCandidates` enforces both). Not used for compaction,
 * which runs on the session model to reuse the provider prompt cache.
 */
export function pickEconomicalContainedModel(
	available: Model<Api>[],
	sessionModel: Model<Api> | undefined,
): EconomicalModelChoice | undefined {
	if (!sessionModel) return undefined;
	const cheaper = cheaperContainedCandidates(available, sessionModel, { role: "reader" })[0];
	return cheaper ? { model: cheaper, via: "tier" } : { model: sessionModel, via: "session" };
}

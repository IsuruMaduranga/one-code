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
 * rejected alternatives: `docs/decisions/model-tiers.md`.
 *
 * The classification obeys the repo convention against id-substring matching as
 * the LEAD signal (see `auto-mode/model-select.ts`): frontier is a version-gated
 * first-party Anthropic allowlist; the non-frontier split leads on a curated
 * anchor map + price + containment, with name-class used only as a *cap* (a
 * lean/fast model class can raise scaffolding, never lower it) and a corroborating
 * "pro"-class hint. The Artificial Analysis Intelligence Index informs the anchor
 * map OFFLINE (`tools/model-tiers/model_tiers.py`) — it is never consulted at
 * runtime (it ranks max-effort benchmark score, not harness reliability).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { modelIdentity, modelsContainedToSession, modelSpec, pricedInput } from "./model-policy.ts";

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
 * effort; see `docs/decisions/model-tiers.md`). Adapted from pi-ai's
 * `defaultSupportsToolReferences` — never Haiku, and the `length < 8` guard stops
 * a dated suffix (`claude-opus-4-8-20251101`) being read as the minor version.
 * Version parse, not price: `claude-opus-4-1` ($15/M) costs more than
 * `opus-4-8`/`opus-5` ($5/M), so cost ranking would misclassify it.
 */
function isAnthropicFrontier(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const family = version[1];
	if (family === "sonnet") return false; // Sonnet is workhorse, never frontier
	const major = Number(version[2]);
	const minor = version[3] && version[3].length < 8 ? Number(version[3]) : 0;
	return major > 4 || (major === 4 && minor >= 7);
}

/**
 * Curated anchor map for well-known third-party families, checked in order
 * (specific before general). A vetted allowlist — distinct from heuristic
 * substring matching — that fixes cases where price/name alone misroute a
 * flagship, and encodes the three ratified overrides (GPT-5-full→workhorse,
 * GPT-5-mini→cheap, GPT-5.6-Luna→cheap). A match here is authoritative (the human
 * already accounted for the name), so it wins outright. Refresh the reference
 * table with `tools/model-tiers/model_tiers.py`.
 */
const ANCHOR_MAP: Array<[RegExp, PromptTier]> = [
	// OpenAI GPT-5 family — order matters: variant suffixes before the generic.
	[/(?:^|[-/.])gpt-5[.\d]*-?nano/i, "tiny"],
	[/(?:^|[-/.])gpt-5[.\d]*-?mini/i, "cheap"], // override: price would say tiny
	[/(?:^|[-/.])gpt-5[.\d]*-?luna/i, "cheap"], // override: OpenAI's cheap line despite a high benchmark
	[/(?:^|[-/.])gpt-5/i, "workhorse"], // gpt-5, gpt-5.x full (sol/terra/codex/base); guards the weak-scoring base variant
	[/(?:^|[-/.])o[34](?:[-/.]|$)/i, "cheap"], // o3, o3-pro, o4-mini
	[/(?:^|[-/.])gpt-4/i, "tiny"], // gpt-4o, gpt-4.1, gpt-4-turbo — prior generation
	// Anthropic reaching this path is gateway-proxied (first-party handled above);
	// a proxied model can't be version-verified for frontier, so Opus/Sonnet → workhorse.
	[/claude[-/.].*haiku/i, "cheap"],
	[/claude[-/.].*(?:sonnet|opus)/i, "workhorse"],
	// Google Gemini — flash-lite is tiny, pro is workhorse; bare flash left to the
	// price+cap heuristic (3.x-flash → cheap, 2.5-flash → tiny) since it varies by gen.
	[/gemini[-.\d]*flash-lite/i, "tiny"],
	[/gemini[-.\d]*pro/i, "workhorse"],
	// Other capable flagships whose price may dip below the workhorse floor.
	[/(?:^|[-/.])grok-4/i, "workhorse"],
];

function anchorTier(id: string): PromptTier | undefined {
	for (const [pattern, tier] of ANCHOR_MAP) if (pattern.test(id)) return tier;
	return undefined;
}

/**
 * Name-class CAP: a lean/fast model class raises scaffolding (never lowers it).
 * Delimited tokens — a bare `/mini/` matches inside "geMINI", dragging every
 * Gemini model to cheap. `\d+b` catches size tags (8b, 70b) as the strongest
 * (tiny) signal. Returns the ceiling tier the name justifies.
 */
const TINY_NAME_HINT = /(?:^|[-/.])(?:nano|lite|tiny|distill|instant|\d+b)(?:[-/.]|$)/i;
const CHEAP_NAME_HINT = /(?:^|[-/.])(?:flash|mini|small|air)(?:[-/.]|$)/i;
function nameClassCap(id: string): PromptTier {
	if (TINY_NAME_HINT.test(id)) return "tiny";
	if (CHEAP_NAME_HINT.test(id)) return "cheap";
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

export function resolveModelTier(
	model: Model<Api> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): PromptTier {
	const forced = tierOverride(env);
	if (forced) return forced;
	if (!model) return "tiny"; // unknown model → maximum scaffolding

	if (isAnthropicFrontier(model)) return "frontier";
	if (model.provider === "anthropic") {
		// First-party non-frontier: Haiku → cheap; Sonnet / Opus 4.1–4.6 / other → workhorse.
		return model.id.includes("haiku") ? "cheap" : "workhorse";
	}

	// A curated anchor is authoritative — but only for a verifiable provider. A
	// local/self-hosted (opaque) provider's id could be anything, so it must NOT
	// reach the anchor map (a model aliased "claude-sonnet-5" on ollama is not the
	// real thing); it falls through to the generic price/name heuristics, where
	// priceFloorTier's opaque check biases it to maximum scaffolding.
	if (modelIdentity(model).confidence !== "opaque") {
		const anchor = anchorTier(model.id);
		if (anchor) return anchor;
	}

	const cap = nameClassCap(model.id);
	// A "pro"/"max"-class name keeps a cheap/unpriced flagship at workhorse; a lean
	// name (cap below workhorse) always wins, so only consult it when cap allows.
	const base = cap === "workhorse" && CAPABLE_NAME_HINT.test(model.id) ? "workhorse" : priceFloorTier(model);
	return moreScaffolded(base, cap);
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
 *     `docs/decisions/auto-mode.md` recorded as still-missing;
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
 */
export function economicalContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	contained?: Model<Api>[],
): Model<Api>[] {
	return (contained ?? modelsContainedToSession(available, sessionModel))
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
	opts: { strict?: boolean; contained?: Model<Api>[] } = {},
): Model<Api>[] {
	const sessionSpec = modelSpec(sessionModel);
	const sessionPrice = pricedInput(sessionModel);
	return economicalContainedCandidates(available, sessionModel, opts.contained).filter((model) => {
		if (modelSpec(model) === sessionSpec) return false;
		if (sessionPrice === undefined) return !opts.strict;
		const price = pricedInput(model);
		return price !== undefined && (opts.strict ? price < sessionPrice : price <= sessionPrice);
	});
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
	const cheaper = cheaperContainedCandidates(available, sessionModel)[0];
	return cheaper ? { model: cheaper, via: "tier" } : { model: sessionModel, via: "session" };
}

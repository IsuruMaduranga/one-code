/**
 * Which system-prompt register + tool surface the active model gets. Claude Code
 * ships a capability-tiered prompt — a short one for Opus ≥ 4.8, Sonnet ≥ 5.5
 * and Fable, a much longer, more explicit one for Haiku and the older Sonnets
 * and Opuses (findings §56). One Code serves every provider, so
 * its non-frontier audience extends *below* Haiku; a single lean prompt
 * under-instructs it. This module maps a model to one of FOUR tiers:
 *
 *   frontier   Claude Code's own short-prompt models, and OpenAI's GPT-6+ Astra and Sol
 *   workhorse  a vendor's large current models — the long register
 *   cheap      a vendor's smaller or older models — the long register
 *   tiny       literally small models — verbose + weak-model scaffolding + grep/find/ls
 *
 * `extensions/system-prompt` picks the prompt text from the tier;
 * `extensions/search-tools` activates grep/find/ls only for `tiny`. Frontier is
 * a version-gated first-party allowlist (Claude Code's own rule); below it the
 * tier comes from the public catalogs (`model-catalog.ts`: release date, price
 * and size against the same vendor's current models), with no model names,
 * dollar floors or benchmark scores in the code. Rationale + rejected
 * alternatives: `working-docs/decisions/model-tiers.md`.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readJsonFile } from "./atomic-write.ts";
import { autoSelectable, catalogModelFor, sizeFromName, smallByName, TINY_PARAMS } from "./model-catalog.ts";
import {
	BUILTIN_PROVIDER_POLICIES,
	baseModelId,
	isDatedDuplicate,
	modelIdentity,
	modelsContainedToSession,
	modelSpec,
	pricedInput,
	providerPolicy,
	supportsImageInput,
} from "./model-policy.ts";
import { oneCodeSettingsPath } from "./one-code-settings.ts";

export type PromptTier = "frontier" | "workhorse" | "cheap" | "tiny";

/** More-scaffolded = higher rank. */
const TIER_RANK: Record<PromptTier, number> = { frontier: 0, workhorse: 1, cheap: 2, tiny: 3 };

/** Whether `value` names one of the four tiers. */
export function isPromptTier(value: unknown): value is PromptTier {
	return typeof value === "string" && Object.hasOwn(TIER_RANK, value);
}

/** How many tiers `tier` sits below `reference` (negative when above). */
export function tiersBelow(tier: PromptTier, reference: PromptTier): number {
	return TIER_RANK[tier] - TIER_RANK[reference];
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
	return isPromptTier(raw) ? raw : undefined;
}

/**
 * Anthropic first-party frontier gate: Opus ≥ 4.8, Sonnet ≥ 5.5 and every
 * Fable — the models Claude Code gives its short prompt and tool forms (Opus
 * 4.7 and Sonnet 5 get the long ones). Claude Code decides this by version, so
 * One Code does too. Adapted from pi-ai's
 * `defaultSupportsToolReferences` — never Haiku, and the `length < 8` guard stops
 * a dated suffix (`claude-opus-4-8-20251101`) being read as the minor version.
 * Version parse, not price: `claude-opus-4-1` ($15/M) costs more than
 * `opus-4-8`/`opus-5` ($5/M), so cost ranking would misclassify it.
 */
function isAnthropicFrontier(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = parseClaudeVersion(model.id);
	if (!version) return false;
	if (version.family === "fable") return true;
	if (version.family === "sonnet") return version.major > 5 || (version.major === 5 && version.minor >= 5);
	return version.major > 4 || (version.major === 4 && version.minor >= 8);
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
	const policy = providerPolicy(model.provider);
	if (policy.kind !== "direct" || policy.profile !== "openai") return false;
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
 * A Claude model id in any provider's spelling (`claude-opus-5-5`,
 * `claude-haiku-4-5-20251001`, `anthropic/claude-sonnet-5.5`, Bedrock's
 * `us.anthropic.claude-fable-5-1-v1`): family, major, and minor when the id
 * has one. A dated suffix is never read as the minor version. Undefined for
 * anything else. `parseClaudeVersion` stays first-party only, for the gates.
 */
export function parseClaudeId(id: string): { family: "opus" | "sonnet" | "haiku" | "fable"; major: number; minor?: number } | undefined {
	const match = id.match(/(?:^|[/.])claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?(?=$|[-@:[])/);
	if (!match) return undefined;
	return { family: match[1] as "opus" | "sonnet" | "haiku" | "fable", major: Number(match[2]), ...(match[3] ? { minor: Number(match[3]) } : {}) };
}

/** The Claude family of a model id in any provider's spelling. */
export function claudeFamily(id: string): "opus" | "sonnet" | "haiku" | "fable" | undefined {
	return parseClaudeId(id)?.family;
}

export interface TierClassification {
	tier: PromptTier;
	/** Which rule decided, for the catalog-wide snapshot and the doctor report. */
	reason: string;
}

/**
 * The tier and the rule that produced it. `resolveModelTier` is the plain form.
 * In order:
 *   1. `CC_PROMPT_TIER` (the session's register only; selection ignores it);
 *   2. the user's `modelTiers` setting for this model;
 *   3. the Claude Code parity gate: first-party Opus ≥ 4.8, Sonnet ≥ 5.5,
 *      Fable, and OpenAI's GPT-6+ Astra and Sol are frontier;
 *   4. the catalog tier (`model-catalog.ts`): tiny by size, workhorse or cheap
 *      by size or price against the same vendor's current models, demoted one
 *      step by age;
 *   5. a model no catalog knows: tiny when its id names a small size or it is
 *      unpriced or on a custom provider, cheap otherwise.
 */
export function classifyModelTier(model: Model<Api> | undefined, env: NodeJS.ProcessEnv = process.env): TierClassification {
	const forced = tierOverride(env);
	if (forced) return { tier: forced, reason: "CC_PROMPT_TIER" };
	if (!model) return { tier: "tiny", reason: "no model" }; // unknown model → maximum scaffolding
	const configured = configuredModelTier(model);
	if (configured) return { tier: configured, reason: "modelTiers setting" };
	if (isAnthropicFrontier(model)) return { tier: "frontier", reason: "anthropic frontier allowlist" };
	if (isOpenAIFrontier(model)) return { tier: "frontier", reason: "openai frontier allowlist" };
	const entry = catalogModelFor(model);
	if (entry) return { tier: entry.tier, reason: `catalog ${entry.id}: ${entry.reason}` };
	const id = baseModelId(model.id);
	const size = sizeFromName(id);
	if (size !== undefined && size < TINY_PARAMS) return { tier: "tiny", reason: "not in the catalogs; a small size in its id" };
	if (size === undefined && smallByName(id)) return { tier: "tiny", reason: "not in the catalogs; a small-model name" };
	if (modelIdentity(model).confidence === "opaque" && !(model.provider in BUILTIN_PROVIDER_POLICIES)) {
		return { tier: "tiny", reason: "custom provider, not in the catalogs" };
	}
	if (pricedInput(model) === undefined) return { tier: "tiny", reason: "unpriced, not in the catalogs" };
	return { tier: "cheap", reason: "not in the catalogs" };
}

/**
 * The user's own tier for a model from `modelTiers` in `~/.onecode/settings.json`,
 * keyed by `provider/id` or by bare id (`{ "openrouter/qwen/qwen3.8-max": "workhorse" }`).
 * User settings only: a project cannot loosen its own permission gate.
 */
function configuredModelTier(model: { provider: string; id: string }): PromptTier | undefined {
	const tiers = modelTierOverrides();
	return tiers[`${model.provider}/${model.id}`] ?? tiers[model.id];
}

let overrideMemo: { path: string; at: number; mtimeMs: number; tiers: Record<string, PromptTier> } | undefined;
let overridesPinned: Record<string, PromptTier> | undefined;

/** Test seam: pin the `modelTiers` map (`undefined` reads the settings file again). */
export function setModelTierOverridesForTest(tiers: Record<string, PromptTier> | undefined): void {
	overridesPinned = tiers;
	overrideMemo = undefined;
}

/**
 * The validated `modelTiers` map. Stat-checked at most once a second and
 * re-parsed only when the settings file's mtime moved: the permission gate asks
 * on every tool call.
 */
export function modelTierOverrides(): Record<string, PromptTier> {
	if (overridesPinned) return overridesPinned;
	const path = oneCodeSettingsPath(homedir());
	const now = Date.now();
	if (overrideMemo && overrideMemo.path === path && now - overrideMemo.at < 1000) return overrideMemo.tiers;
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		// No settings file: no overrides.
	}
	if (overrideMemo && overrideMemo.path === path && overrideMemo.mtimeMs === mtimeMs) {
		overrideMemo.at = now;
		return overrideMemo.tiers;
	}
	const raw = mtimeMs < 0 ? undefined : readJsonFile<{ modelTiers?: unknown }>(path)?.modelTiers;
	const tiers: Record<string, PromptTier> = {};
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (isPromptTier(value)) tiers[key] = value;
		}
	}
	overrideMemo = { path, at: now, mtimeMs, tiers };
	return tiers;
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
export function taskToolsEnabled(
	model: Model<Api> | undefined,
	env: NodeJS.ProcessEnv = process.env,
	/** Request-surface callers pass the session's frozen tier (session-model-tier.ts). */
	tier?: PromptTier,
): boolean {
	if (TRUTHY_ENV.has(env.CLAUDE_CODE_ENABLE_TODO_TOOLS?.trim().toLowerCase() ?? "")) return true;
	if (!model) return true;
	if ((tier ?? resolveModelTier(model, env)) === "frontier") return false;
	if (model.provider !== "anthropic") return true;
	const version = parseClaudeVersion(model.id);
	return !(version?.family === "sonnet" && version.major >= 5);
}


/**
 * The ordered candidate chain for an automatic *secondary* model — the same
 * mechanism the auto-mode classifier, subagents and readers consume before
 * their own budget and tier rules decide which models qualify.
 *
 * The chain is:
 *   - **contained** to the session's provider (and route/family on gateways):
 *     the classifier reads the user's prompts + CLAUDE.md and subagents inherit
 *     the parent transcript, so leaving the session's provider silently is a
 *     privacy leak — only an explicit setting may cross (see the two model-select
 *     modules);
 *   - never `tiny`: a small model is a weak security boundary and a weak coding
 *     worker, so automatic selection stops at `cheap`;
 *   - known to the catalogs and selectable there (`model-catalog.ts`): not
 *     superseded by a newer model of its vendor in the same price band that
 *     this pool also offers, not two years behind its vendor's newest, not
 *     deprecated, able to call tools, a text model. A row no catalog knows is
 *     never picked automatically;
 *   - priced only: on a provider with no usable prices the chain is empty and
 *     callers degrade to the session model (correct, merely not cheap).
 *
 * Sorted by cost preference (cheapest *tier* first) then input price, so the
 * head is "the cheapest usable model this provider offers." The session model
 * may appear in the chain; the budget-gated `cheaperContainedCandidates` drops
 * it. Budget ceilings and tier floors are caller policy — this function ranks,
 * it does not gate. A caller that already computed the containment set may
 * pass it as `contained` to skip the O(catalog) recompute.
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
	// Modality gate: when the session works with images/PDFs a subagent may
	// need to read, a text-only worker cannot serve — drop it before ranking.
	const usable = requireImageInput ? pool.filter(supportsImageInput) : pool;
	// A superseded model is skipped only for a successor this pool can pick.
	const served = servedCatalogIds(usable);
	return usable
		// A dated snapshot whose undated alias is also listed is the same model
		// twice; rank the alias so every automatic pick (classifier, subagent,
		// reader, presets) names the model the way the user sees it in /model.
		.filter((model) => !isDatedDuplicate(model, pool))
		.filter((model) => isAutoSelectable(model, served))
		// Classify by the model's INTRINSIC tier — never `process.env`: CC_PROMPT_TIER
		// forces the *session's* prompt-scaffolding register, and honoring it here
		// would collapse every candidate to one tier and let a `tiny` model through
		// the security floor. Selection must judge each model on its own merits.
		.map((model) => ({ model, tier: intrinsicTier(model), price: pricedInput(model) }))
		.filter(
			(entry): entry is { model: Model<Api>; tier: Exclude<PromptTier, "tiny">; price: number } =>
				entry.tier !== "tiny" && entry.price !== undefined,
		)
		.sort((a, b) => COST_PREFERENCE[a.tier] - COST_PREFERENCE[b.tier] || a.price - b.price)
		.map((entry) => entry.model);
}

/**
 * Whether automatic selection may pick `model` at all: the catalogs know it and
 * do not mark it legacy, deprecated, tool-less or non-text, or superseded by a
 * model `served` holds (`model-catalog.ts autoSelectable`; `served` is
 * `servedCatalogIds` of the session's contained pool). A model the user tiered
 * by hand in `modelTiers` still needs a catalog entry: the setting speaks to
 * its tier, not to whether it is current.
 */
export function isAutoSelectable(model: Model<Api>, served: ReadonlySet<string>): boolean {
	const entry = catalogModelFor(model);
	return entry !== undefined && autoSelectable(entry, served);
}

/** The catalog models a pool of pi rows serves: where a successor must be for supersession to skip a model. */
export function servedCatalogIds(pool: readonly Model<Api>[]): Set<string> {
	const ids = new Set<string>();
	for (const model of pool) {
		const entry = catalogModelFor(model);
		if (entry) ids.add(entry.id);
	}
	return ids;
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
 * Whether the permission gate gives `model`'s calls Claude Code's fast paths.
 * Frontier and workhorse do; cheap and tiny keep One Code's stricter gate
 * (working-docs/decisions/auto-mode.md, "Two gates by model tier"). Judged on
 * the intrinsic tier, so `CC_PROMPT_TIER` can never loosen the gate; no model
 * gets the stricter gate.
 */
export function usesClaudeCodeFastPaths(model: Model<Api> | undefined): boolean {
	return !!model && atLeastTier(intrinsicTier(model), "workhorse");
}

/**
 * The budget-gated form the automatic secondary-model pickers all share: same as
 * `economicalContainedCandidates`, minus the session model itself and anything
 * dearer than it. `strict` requires *strictly* cheaper (the subagent default and
 * the classifier: a same-price model saves nothing); non-strict allows equal
 * price (the reader). With the session price unknown there is no demonstrable
 * saving, so `strict` yields nothing while non-strict keeps the tier-ranked
 * list. `contained` is forwarded to skip the containment recompute.
 */
export function cheaperContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	opts: { strict?: boolean; contained?: Model<Api>[]; requireImageInput?: boolean } = {},
): Model<Api>[] {
	const sessionSpec = modelSpec(sessionModel);
	const sessionPrice = pricedInput(sessionModel);
	return economicalContainedCandidates(available, sessionModel, opts.contained, opts.requireImageInput).filter((model) => {
		if (modelSpec(model) === sessionSpec) return false;
		if (sessionPrice === undefined) return !opts.strict;
		const price = pricedInput(model);
		return price !== undefined && (opts.strict ? price < sessionPrice : price <= sessionPrice);
	});
}

/**
 * The subagent default and the classifier's automatic pick: the strictly
 * cheaper contained candidates (`cheaperContainedCandidates`) in the session's
 * own tier or above, cheapest first. A workhorse session delegates to the cheapest workhorse-or-better
 * model, a frontier session to the cheapest frontier one; a tiny session, whose
 * tier automatic selection never picks, to the cheapest cheap-or-better one.
 * The head is "the cheapest model this provider offers that is not weaker than
 * the session's".
 */
export function sameTierContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	opts: { contained?: Model<Api>[]; requireImageInput?: boolean } = {},
): Model<Api>[] {
	const floor = intrinsicTier(sessionModel);
	return cheaperContainedCandidates(available, sessionModel, { ...opts, strict: true })
		.filter((model) => atLeastTier(intrinsicTier(model), floor))
		.sort((a, b) => pricedInput(a)! - pricedInput(b)!);
}

export interface EconomicalModelChoice {
	model: Model<Api>;
	via: "tier" | "session";
}

/**
 * The cheapest usable same-provider model, else the session model itself. Used
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

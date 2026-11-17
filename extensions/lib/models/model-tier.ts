/**
 * Which system-prompt register + tool surface the active model gets. Claude Code
 * ships a capability-tiered prompt — a short one for Opus ≥ 4.8, Sonnet ≥ 5.5
 * and Fable, a much longer, more explicit one for Haiku and the older Sonnets
 * and Opuses (findings §56). One Code serves every provider, so
 * its non-frontier audience extends *below* Haiku; a single lean prompt
 * under-instructs it. This module maps a model to one of FOUR tiers:
 *
 *   frontier   Claude Code's own short-prompt models, OpenAI's GPT-6+ Astra and Sol,
 *              and Google's Gemini 4+ Carbon and Hydrogen
 *   workhorse  a vendor's large current models — the long register
 *   cheap      a vendor's smaller or older models — the long register
 *   tiny       literally small models — verbose + weak-model scaffolding
 *
 * `extensions/request/system-prompt` picks the prompt text from the tier;
 * `extensions/tools/search-tools` activates grep/find/ls only for `tiny`, unless
 * the profile turns those tools off (`searchToolsEnabled`). Frontier is a
 * version-gated allowlist per lab, on the lab's own providers and the known
 * gateways (`labModel`); below it the
 * tier comes from the public catalogs (`model-catalog.ts`: release date, price
 * and size against the same vendor's current models), with no model names,
 * dollar floors or benchmark scores in the code. Rationale + rejected
 * alternatives: `working-docs/decisions/model-tiers.md`.
 */

import { envName } from "../profile/brand.mjs";
import { knobValue } from "../profile/knobs.ts";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readJsonFile } from "../core/atomic-write.ts";
import { autoSelectable, catalogModelFor, isDatedDuplicate, sizeFromName, smallByName, TINY_PARAMS } from "./model-catalog.ts";
import {
	anthropicModelId,
	baseModelId,
	isBatchEndpoint,
	isKnownProvider,
	isExperimentalBuild,
	isMovingAlias,
	modelIdentity,
	modelsContainedToSession,
	modelSpec,
	pricedInput,
	providerPolicy,
	supportsImageInput,
} from "./model-policy.ts";
import { productSettingsPath } from "../profile/product-settings.ts";
import { isPlainObject } from "../core/plain-object.ts";
import { isPromptTier, PROMPT_TIERS, type PromptTier, TIER_RANK } from "./prompt-tiers.ts";

export { isPromptTier, PROMPT_TIERS, type PromptTier };

/** How many tiers `tier` sits below `reference` (negative when above). */
export function tiersBelow(tier: PromptTier, reference: PromptTier): number {
	return TIER_RANK[tier] - TIER_RANK[reference];
}

/**
 * `*_PROMPT_TIER=frontier|workhorse|cheap|tiny` forces a register; `auto`/unset
 * classifies. Env only — a project must not be able to downgrade its own
 * scaffolding, the same reasoning that keeps `autoMode` out of project settings.
 */
export function tierOverride(env: NodeJS.ProcessEnv = process.env): PromptTier | undefined {
	const raw = knobValue("PROMPT_TIER", env)?.trim().toLowerCase();
	return isPromptTier(raw) ? raw : undefined;
}

/** The labs with a frontier rule. */
type FrontierLab = "anthropic" | "openai" | "google";

const FRONTIER_LABS: ReadonlySet<string> = new Set<FrontierLab>(["anthropic", "openai", "google"]);

/** A frontier lab's model as the lab spells its id, and whether the session reaches it directly or through a gateway. */
interface LabModel {
	lab: FrontierLab;
	id: string;
	via: "first-party" | "gateway";
}

/**
 * The frontier lab behind a row and the row's id in the lab's own spelling,
 * or undefined when the row is no frontier lab's model or its route proves
 * nothing.
 *
 * First party: Anthropic's provider (or one the profile says serves
 * Anthropic's models, `anthropicModelId`), and a direct provider of OpenAI
 * (`openai`, `openai-codex`, `azure`, `azure-openai-responses`) or Google
 * (`google`, `google-vertex`) serving its own vendor's ids.
 *
 * Gateway: a provider `providerPolicy` classes as a gateway (`openrouter`,
 * `vercel-ai-gateway`, `cloudflare-ai-gateway`), where the row names the lab.
 * OpenRouter and Vercel name all three labs by the id's vendor prefix
 * (`anthropic/`, `openai/`, `google/`). Cloudflare names only Anthropic and
 * OpenAI, by API route (`cloudflareGatewayIdentity`): it carries no Gemini
 * row in pi's catalog, its Google models are Workers AI open models (Gemma),
 * and its OpenAI-compatible route serves several vendors, so a Gemini id
 * there proves nothing and the Google gate is out of its reach.
 * Closed models run only at the lab and its cloud partners, and a gateway
 * forwards to those, so a gateway copy is the lab's model (decided
 * 2026-11-17). Hosted and opaque providers stay out: a custom provider whose
 * id starts with `anthropic/` proves nothing. Refused on purpose: a moving
 * alias (`~anthropic/claude-opus-latest`), which names no version, and a
 * batch endpoint (OpenRouter's `:batch`, Vercel's `-batch`), a deferred SKU
 * no session runs on that keeps its catalog tier (Vercel's are in no
 * catalog, so lifting them would loosen the permission gate on a guess).
 * Another endpoint variant (`:thinking`, `:free`, `:online`) is the same
 * model and reads as its base id; Vercel's `-fast` suffix falls through the
 * version parse. Anthropic's dotted version on a gateway
 * (`claude-sonnet-5.5`) is rewritten the way Anthropic writes it
 * (`claude-sonnet-5-5`).
 *
 * Only the tier reads this: Anthropic wire features and server tools stay on
 * `anthropicModelId` and `acceptsAnthropicWire`, which no gateway passes.
 */
function labModel(model: Model<Api>): LabModel | undefined {
	const anthropic = anthropicModelId(model);
	if (anthropic !== undefined) return { lab: "anthropic", id: anthropic, via: "first-party" };
	const policy = providerPolicy(model.provider);
	if (policy.kind === "direct") {
		// The provider's own vendor only: Azure's Foundry rows from other vendors are not OpenAI's.
		const profile = modelIdentity(model).profile;
		return (profile === "openai" || profile === "google") && profile === policy.profile ? { lab: profile, id: model.id, via: "first-party" } : undefined;
	}
	if (policy.kind !== "gateway" || isMovingAlias(model.id) || isBatchEndpoint(model)) return undefined;
	const identity = modelIdentity(model);
	if (identity.confidence === "opaque" || identity.profile === undefined || !FRONTIER_LABS.has(identity.profile)) return undefined;
	const lab = identity.profile as FrontierLab;
	const id = baseModelId(identity.normalizedId).toLowerCase();
	return { lab, id: lab === "anthropic" ? id.replace(/^(claude-[a-z]+-\d+)\.(\d{1,2})(?=-|$)/, "$1-$2") : id, via: "gateway" };
}

/**
 * Anthropic frontier gate on a lab-spelled id: Opus ≥ 4.8, Sonnet ≥ 5.5 and
 * every Fable — the models Claude Code gives its short prompt and tool forms
 * (Opus 4.7 and Sonnet 5 get the long ones; findings §56). Haiku 5 and later
 * get the short forms too, but only for the prompt (`isHaikuWithFrontierForms`).
 * Claude Code decides this by version, so One Code does too. Adapted from pi-ai's
 * `defaultSupportsToolReferences` — never Haiku, and the `length < 8` guard stops
 * a dated suffix (`claude-opus-4-8-20251101`) being read as the minor version.
 * Version parse, not price: `claude-opus-4-1` ($15/M) costs more than
 * `opus-4-8`/`opus-5` ($5/M), so cost ranking would misclassify it.
 */
function isAnthropicFrontier(id: string): boolean {
	if (id.includes("haiku")) return false;
	const version = parseClaudeVersion(id);
	if (!version) return false;
	if (version.family === "fable") return true;
	if (version.family === "sonnet") return version.major > 5 || (version.major === 5 && version.minor >= 5);
	return version.major > 4 || (version.major === 4 && version.minor >= 8);
}

/**
 * Haiku 5 and later take the frontier prompt and tool forms (findings §68),
 * but nothing else that reads the tier: model selection, the permission
 * gate's fast paths and the doctor judge a Haiku by its catalog tier, so the
 * cost algorithm never offers one as an Opus-class substitute. Through a
 * gateway too: Claude Code chooses the forms by model, and the gateway serves
 * the same model.
 */
function isHaikuWithFrontierForms(id: string): boolean {
	const major = id.match(/^claude-haiku-(\d+)(?:-|$)/)?.[1];
	return major !== undefined && Number(major) >= 5;
}

/** What a tier is for: the session's prompt and tool forms, or judging a model's capability. */
export type TierPurpose = "prompt" | "capability";

/**
 * OpenAI frontier gate on a lab-spelled id: the GPT-6 Astra and Sol lines and
 * later majors (`gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol-pro`). GPT-5.x Sol
 * and Terra, and every Luna, stay below it (decided 2026-09-25: Astra and
 * Sol 6 are the OpenAI models comparable to Fable and Opus 5).
 */
function isOpenAIFrontier(id: string): boolean {
	const match = id.match(/^gpt-(\d+)(?:\.\d+)?-(?:astra|sol)(?:-|$)/);
	return match !== null && Number(match[1]) >= 6;
}

/**
 * Google frontier gate on a lab-spelled id: the Gemini 4 Carbon and Hydrogen
 * lines and later majors (decided 2026-11-17, from the Intelligence Index:
 * Carbon 60 and Hydrogen 54 against Opus 5.5's 59 and Sonnet 5.5's 55).
 * Gemini 4 Argon (50, beside GPT-6.1 Terra's 51) and every Flash stay at
 * their catalog tier. pi's catalog lists only `gemini-4-argon` of the line
 * so far; `gemini-4-carbon` and `gemini-4-hydrogen` are the spellings the
 * bundled models.dev and OpenRouter catalogs use, so the gate reads the line
 * name and major the way the OpenAI one does.
 */
function isGoogleFrontier(id: string): boolean {
	const match = id.match(/^gemini-(\d+)(?:\.\d+)?-(?:carbon|hydrogen)(?:-|$)/);
	return match !== null && Number(match[1]) >= 4;
}

/**
 * A smaller variant of a lab's line (`gpt-6-sol-nano`, `gemini-4-hydrogen-lite`,
 * `claude-sonnet-5.5-mini`, `gemini-4-carbon-flash`): the catalogs' small-model
 * reading (`smallByName`, a size tag under the tiny bound) or a `mini` or
 * `flash` tag. No frontier gate admits one, on any provider, so it keeps its
 * catalog tier or the small-name guess. `-pro`, `-fast`, `-preview` and dated
 * ids are not small and pass.
 */
function isSmallVariant(id: string): boolean {
	const size = sizeFromName(id);
	return smallByName(id) || (size !== undefined && size < TINY_PARAMS) || /(?:^|[-/.])(?:mini|flash)(?:[-/.:]|$)/i.test(id);
}

/** The frontier rule that admits `model` for `purpose`, as the reason the tier report prints, or undefined. */
function frontierReason(model: Model<Api>, purpose: TierPurpose): string | undefined {
	const lab = labModel(model);
	if (!lab || isSmallVariant(lab.id)) return undefined;
	const reason = (...notes: string[]): string => {
		const all = lab.via === "gateway" ? [...notes, "gateway"] : notes;
		return `${lab.lab} frontier allowlist${all.length > 0 ? ` (${all.join(", ")})` : ""}`;
	};
	switch (lab.lab) {
		case "anthropic":
			if (isAnthropicFrontier(lab.id)) return reason();
			if (purpose === "prompt" && isHaikuWithFrontierForms(lab.id)) return reason("prompt and tool forms");
			return undefined;
		case "openai":
			return isOpenAIFrontier(lab.id) ? reason() : undefined;
		case "google":
			return isGoogleFrontier(lab.id) ? reason() : undefined;
	}
}

/**
 * Structural parse of a Claude model id in Anthropic's spelling (`claude-opus-4-8`,
 * `claude-sonnet-5`, `claude-opus-4-5-20251101`): family, major, minor. A
 * dated suffix is never read as the minor version (the `length < 8` guard).
 * Undefined for anything else, a gateway's dotted `claude-opus-5.5` included
 * (`labModel` rewrites it first). Shared by the frontier gate here and the
 * server-tools gate in `anthropic-server-tools.ts`.
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

export { claudeFamily, parseClaudeId } from "../profile/claude-id.ts";

export interface TierClassification {
	tier: PromptTier;
	/** Which rule decided, for the catalog-wide snapshot and the doctor report. */
	reason: string;
}

/**
 * The tier and the rule that produced it. `resolveModelTier` is the plain form.
 * In order:
 *   1. `*_PROMPT_TIER` (the session's register only; selection ignores it);
 *   2. the user's `modelTiers` setting for this model;
 *   3. the frontier allowlist, on a lab's own provider or a known gateway
 *      (`labModel`): Opus ≥ 4.8, Sonnet ≥ 5.5, Fable, OpenAI's GPT-6+ Astra
 *      and Sol, and Google's Gemini 4+ Carbon and Hydrogen; for the prompt
 *      (`purpose: "prompt"`, the default) Haiku ≥ 5 is too;
 *   4. the catalog tier (`model-catalog.ts`): tiny by size, workhorse or cheap
 *      by size or price against the same vendor's current models, demoted one
 *      step by age;
 *   5. a model no catalog knows: tiny when its id names a small size or it is
 *      unpriced or on a custom provider, cheap otherwise.
 */
export function classifyModelTier(
	model: Model<Api> | undefined,
	env: NodeJS.ProcessEnv = process.env,
	purpose: TierPurpose = "prompt",
): TierClassification {
	const { tier, reason } = classifyWithBasis(model, env, purpose);
	return { tier, reason };
}

/**
 * `classifyModelTier` with whether a rule that knows the model decided: the
 * user's `modelTiers` entry, a vendor's frontier rule or a catalog entry
 * (`known`), or a guess for a model none of them knows (no model, an id
 * the catalogs lack, a custom provider, no price), or the prompt-tier knob.
 */
function classifyWithBasis(model: Model<Api> | undefined, env: NodeJS.ProcessEnv, purpose: TierPurpose): TierClassification & { known: boolean } {
	const forced = tierOverride(env);
	if (forced) return { tier: forced, reason: envName("PROMPT_TIER"), known: false };
	if (!model) return { tier: "tiny", reason: "no model", known: false }; // unknown model → maximum scaffolding
	const configured = configuredModelTier(model);
	if (configured) return { tier: configured, reason: "modelTiers setting", known: true };
	const frontier = frontierReason(model, purpose);
	if (frontier) return { tier: "frontier", reason: frontier, known: true };
	const entry = catalogModelFor(model);
	if (entry) return { tier: entry.tier, reason: `catalog ${entry.id}: ${entry.reason}`, known: true };
	const id = baseModelId(model.id);
	const size = sizeFromName(id);
	if (size !== undefined && size < TINY_PARAMS) return { tier: "tiny", reason: "not in the catalogs; a small size in its id", known: false };
	if (size === undefined && smallByName(id)) return { tier: "tiny", reason: "not in the catalogs; a small-model name", known: false };
	if (modelIdentity(model).confidence === "opaque" && !isKnownProvider(model.provider)) {
		return { tier: "tiny", reason: "custom provider, not in the catalogs", known: false };
	}
	if (pricedInput(model) === undefined) return { tier: "tiny", reason: "unpriced, not in the catalogs", known: false };
	return { tier: "cheap", reason: "not in the catalogs", known: false };
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
	const path = productSettingsPath(homedir());
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
	if (isPlainObject(raw)) {
		for (const [key, value] of Object.entries(raw)) {
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

/** pi's built-in search tools: registered by pi, active only where `searchToolsEnabled` says so. */
export const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

/**
 * Whether the session has the dedicated search tools: the tiny tier, and all
 * three live. They are one unit: with any of them off (a profile's tool
 * switch, the environment) the session searches through the shell, so the
 * tool surface and the text that names it follow this one answer.
 */
export function searchToolsEnabled(tier: PromptTier, live: (tool: string) => boolean): boolean {
	return tier === "tiny" && SEARCH_TOOLS.every((tool) => live(tool));
}

/**
 * Whether the session gets the task tools (`task_create` and family), the
 * system prompt's task bullet and the task reminder: off for every model, in
 * every tier, unless the `ENABLE_TODO_TOOLS` knob (lib/profile/knobs.ts) turns
 * them on. Models given the bullet kept needless lists for ordinary work, and
 * Claude Code gives its current models no task tools either (findings §31).
 * Callers combine it with the profile's tool switches, which still turn the
 * tools off for good. working-docs/decisions/tools.md.
 */
export function taskToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return TRUTHY_ENV.has(knobValue("ENABLE_TODO_TOOLS", env)?.trim().toLowerCase() ?? "");
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
 * Sorted by input price, the more capable tier first at equal price, so the
 * head is "the cheapest usable model this provider offers." Price leads, not
 * tier: a frontier model cheaper than every cheap one (Haiku 5.5 against Haiku
 * 4.5) is the better pick on both counts. The session model
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
		// Classify by the model's INTRINSIC tier — never `process.env`: *_PROMPT_TIER
		// forces the *session's* prompt-scaffolding register, and honoring it here
		// would collapse every candidate to one tier and let a `tiny` model through
		// the security floor. Selection must judge each model on its own merits.
		.map((model) => ({ model, tier: intrinsicTier(model), price: pricedInput(model) }))
		.filter(
			(entry): entry is { model: Model<Api>; tier: PromptTier; price: number } =>
				entry.tier !== "tiny" && entry.price !== undefined,
		)
		.sort((a, b) => a.price - b.price || TIER_RANK[a.tier] - TIER_RANK[b.tier])
		.map((entry) => entry.model);
}

/**
 * Whether automatic selection may pick `model` at all: the catalogs know it and
 * do not mark it legacy, deprecated, tool-less or non-text, it is not an
 * experimental build (`isExperimentalBuild`), and it is not superseded by a
 * model `served` holds (`model-catalog.ts autoSelectable`; `served` is
 * `servedCatalogIds` of the session's contained pool). A model the user tiered
 * by hand in `modelTiers` still needs a catalog entry: the setting speaks to
 * its tier, not to whether it is current.
 */
export function isAutoSelectable(model: Model<Api>, served: ReadonlySet<string>): boolean {
	// The pi id too: a row can name an experimental build its catalog entry does not.
	if (isExperimentalBuild(model.id)) return false;
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

/** No *_PROMPT_TIER override: automatic model *selection* always uses intrinsic tiers. */
const INTRINSIC_TIER_ENV: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

/**
 * A model's own capability tier, *_PROMPT_TIER ignored — what selection, the
 * permission gate and the doctor judge a model by. It differs from the prompt
 * tier only for Haiku 5 and later (`isHaikuWithFrontierForms`).
 */
export function intrinsicTier(model: Model<Api>): PromptTier {
	return classifyModelTier(model, INTRINSIC_TIER_ENV, "capability").tier;
}

/** A model's capability tier, and whether a rule that knows the model decided it (`modelCapability`). */
export interface ModelCapability {
	tier: PromptTier;
	/**
	 * True when the user's `modelTiers` entry, a vendor's frontier rule or a
	 * catalog entry (by size, price or age against the vendor's models)
	 * decided; false for no model and for a model none of them knows (an id
	 * the catalogs lack, a custom provider, no price), whose tier is a guess.
	 */
	known: boolean;
}

/**
 * The model's capability tier, the reading `intrinsicTier` gives (Haiku 5
 * and later below frontier, `*_PROMPT_TIER` ignored, the user's `modelTiers`
 * applied), with whether it is known or guessed. For judging a model, not
 * for text that must match the session's prompt register (`sessionModelTier`).
 */
export function modelCapability(model: Model<Api> | undefined): ModelCapability {
	const { tier, known } = classifyWithBasis(model, INTRINSIC_TIER_ENV, "capability");
	return { tier, known };
}

/** Whether `tier` is at least as capable as `floor` (frontier ≥ workhorse ≥ cheap ≥ tiny). */
export function atLeastTier(tier: PromptTier, floor: PromptTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[floor];
}

/**
 * Whether the permission gate gives `model`'s calls Claude Code's fast paths.
 * Frontier and workhorse do; cheap and tiny keep One Code's stricter gate
 * (working-docs/decisions/auto-mode.md, "Two gates by model tier"). Judged on
 * the intrinsic tier, so `*_PROMPT_TIER` can never loosen the gate; no model
 * gets the stricter gate.
 */
export function usesClaudeCodeFastPaths(model: Model<Api> | undefined): boolean {
	return !!model && atLeastTier(intrinsicTier(model), "workhorse");
}

/** A model's price for comparing candidates, or undefined when it has none. */
export type ModelPrice = (model: Model<Api>) => number | undefined;

/**
 * The budget-gated form the automatic secondary-model pickers all share: same as
 * `economicalContainedCandidates`, minus the session model itself and anything
 * dearer than it. `strict` requires *strictly* cheaper (the subagent default and
 * the classifier: a same-price model saves nothing); non-strict allows equal
 * price (the reader). With the session price unknown there is no demonstrable
 * saving, so `strict` yields nothing while non-strict keeps the tier-ranked
 * list. `contained` is forwarded to skip the containment recompute. `price`
 * replaces the list input price (the classifier judges per-call cost).
 */
export function cheaperContainedCandidates(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	opts: { strict?: boolean; contained?: Model<Api>[]; requireImageInput?: boolean; price?: ModelPrice } = {},
): Model<Api>[] {
	const priceOf = opts.price ?? pricedInput;
	const sessionSpec = modelSpec(sessionModel);
	const sessionPrice = priceOf(sessionModel);
	return economicalContainedCandidates(available, sessionModel, opts.contained, opts.requireImageInput).filter((model) => {
		if (modelSpec(model) === sessionSpec) return false;
		if (sessionPrice === undefined) return !opts.strict;
		const price = priceOf(model);
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
	opts: { contained?: Model<Api>[]; requireImageInput?: boolean; price?: ModelPrice } = {},
): Model<Api>[] {
	const priceOf = opts.price ?? pricedInput;
	const floor = intrinsicTier(sessionModel);
	return cheaperContainedCandidates(available, sessionModel, { ...opts, strict: true })
		.filter((model) => atLeastTier(intrinsicTier(model), floor))
		.sort((a, b) => priceOf(a)! - priceOf(b)!);
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

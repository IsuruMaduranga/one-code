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
import { modelIdentity, pricedInput } from "./model-policy.ts";

export type PromptTier = "frontier" | "workhorse" | "cheap" | "tiny";

/** More-scaffolded = higher rank. Used to combine the price floor with the name cap. */
const TIER_RANK: Record<PromptTier, number> = { frontier: 0, workhorse: 1, cheap: 2, tiny: 3 };
function moreScaffolded(a: PromptTier, b: PromptTier): PromptTier {
	return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

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
const TINY_NAME_HINT = /(?:^|[-/.])(?:nano|lite|tiny|distill|\d+b)(?:[-/.]|$)/i;
const CHEAP_NAME_HINT = /(?:^|[-/.])(?:flash|mini|small|air|instant)(?:[-/.]|$)/i;
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
	if (modelIdentity(model).confidence === "opaque") return "tiny"; // local/self-hosted
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

	// Third-party: a curated anchor is authoritative; otherwise the price floor
	// (raised to workhorse by a "pro"-class name) combined with the name-class cap.
	const anchor = anchorTier(model.id);
	if (anchor) return anchor;

	const cap = nameClassCap(model.id);
	// A "pro"/"max"-class name keeps a cheap/unpriced flagship at workhorse; a lean
	// name (cap below workhorse) always wins, so only consult it when cap allows.
	const base = cap === "workhorse" && CAPABLE_NAME_HINT.test(model.id) ? "workhorse" : priceFloorTier(model);
	return moreScaffolded(base, cap);
}

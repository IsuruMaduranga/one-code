/**
 * Which system-prompt register the active model gets. Claude Code ships a
 * capability-tiered prompt — a terse one for frontier models, a much longer,
 * more explicit one for smaller models (Anthropic removed 80%+ of the prompt for
 * Claude-5-gen models with no measured loss). One Code serves every provider, so
 * its non-frontier audience is dominated by models weaker than Haiku; a single
 * lean prompt under-instructs them. This module maps a model to one of three
 * registers; `extensions/system-prompt` picks the prompt text from the result.
 *
 * The classification obeys the repo convention against id-substring matching
 * (see `auto-mode/model-select.ts`): the only id parsing is structural version
 * parsing on first-party Anthropic ids (a namespace we control); for every other
 * provider the decision rests on price + containment, with a name hint as a
 * corroborating signal, never the lead.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { modelIdentity, pricedInput } from "./model-policy.ts";

export type PromptTier = "frontier" | "mid" | "low";

/**
 * `CC_PROMPT_TIER=frontier|mid|low` forces a register; `auto`/unset classifies.
 * Env only — a project must not be able to downgrade its own scaffolding, the
 * same reasoning that keeps `autoMode` out of project settings.
 */
export function tierOverride(env: NodeJS.ProcessEnv = process.env): PromptTier | undefined {
	const raw = env.CC_PROMPT_TIER?.trim().toLowerCase();
	return raw === "frontier" || raw === "mid" || raw === "low" ? raw : undefined;
}

/**
 * Anthropic first-party frontier gate: Opus/Fable ≥ 4.8 or Sonnet ≥ 5. Adapted
 * from pi-ai's `defaultSupportsToolReferences` — never Haiku, and the
 * `length < 8` guard stops a dated suffix (`claude-opus-4-8-20251101`) being read
 * as the minor version. Version parse, not price: `claude-opus-4-1` ($15/M) costs
 * more than `opus-4-8`/`opus-5` ($5/M), so cost ranking would misclassify it.
 */
function isAnthropicFrontier(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const family = version[1];
	const major = Number(version[2]);
	const minor = version[3] && version[3].length < 8 ? Number(version[3]) : 0;
	return family === "sonnet" ? major >= 5 : major > 4 || (major === 4 && minor >= 8);
}

/**
 * Small-model name words that justify the low tier, matched as delimited tokens.
 * Delimiting matters: a bare `/mini/` matches inside "geMINI", which would drag
 * every Gemini model (pro included) to low. Deliberately narrower than
 * model-policy's `NAME_HINTS`, which also counts "haiku"/"sonnet" — those are
 * mid-class, and a gateway-proxied `…/claude-sonnet-5` reaching this branch must
 * not be demoted to the weakest prompt on the strength of its name.
 */
const LOW_TIER_NAME_HINT = /(?:^|[-/.])(?:flash|mini|nano|small|lite|instant)(?:[-/.]|$)/i;

/**
 * A "pro"-class name marks the capable variant of a family (deepseek-v4-pro,
 * gemini-3-pro, gpt-5-pro) — a capability-up signal that keeps a cheap or
 * unpriced flagship in mid rather than low. Matched as a delimited token so it
 * fires on `-pro`/`pro-` but not on `prometheus`, `improved`, or `proxy`.
 */
const CAPABLE_NAME_HINT = /(?:^|[-/.])pro(?:[-/.]|$)/i;

/**
 * Below this input price (USD per million tokens) a model with no other signal
 * is treated as small. Calibrated against the live catalogs: capable flagships
 * sit at ≥ $1/M (gpt-5 1.25, grok 1.25, gemini-pro 1.25–2), while mini/nano/flash
 * classes sit well under $0.5. The boundary is intentionally biased toward `low`
 * (more scaffolding never hurts a cheap model), per the "unknown → low" decision.
 */
const LOW_TIER_MAX_INPUT_COST = 0.5;

export function resolveModelTier(
	model: Model<Api> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): PromptTier {
	const forced = tierOverride(env);
	if (forced) return forced;
	if (!model) return "low"; // unknown model → maximum scaffolding

	if (isAnthropicFrontier(model)) return "frontier";
	if (model.provider === "anthropic") return "mid"; // Haiku, Sonnet < 5, Opus 4.1–4.7

	// A "pro"-class flagship stays mid even when cheap/unpriced, unless the id
	// also carries a small-model word (contradictory — let the small path win).
	if (CAPABLE_NAME_HINT.test(model.id) && !LOW_TIER_NAME_HINT.test(model.id)) return "mid";

	// Otherwise low wins on any positive smallness signal.
	const price = pricedInput(model);
	const small =
		LOW_TIER_NAME_HINT.test(model.id) ||
		modelIdentity(model).confidence === "opaque" || // local/self-hosted providers
		price === undefined || // unpriced/unknown → low
		price < LOW_TIER_MAX_INPUT_COST;
	return small ? "low" : "mid";
}

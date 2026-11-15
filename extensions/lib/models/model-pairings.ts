/**
 * The model pairing table (pure): for the models people run most, which model
 * a session hands its subagents and its auto-mode classifier. Each row comes
 * from measured data, not from tiers or price alone: Artificial Analysis's
 * Intelligence Index (maximum effort for subagents; low effort for the
 * classifier, which runs with thinking off) and list prices, with OpenRouter's
 * usage rankings and the vendors' flagships choosing which models get a row.
 * The snapshot and the numbers behind every row are in
 * `working-docs/decisions/model-policy.md` ("Model pairing table"); the scores
 * are also in `test/unit/fixtures/pairing-scores.json`, from which the tests
 * derive every row.
 *
 * A pick is the cheapest same-vendor model within PAIRING_BARS of the session
 * model: at maximum effort for subagents, at low effort for the classifier,
 * and at maximum effort for the classifier where the session model or the
 * candidate has no low-effort score. The bars apply to scores rounded to one
 * decimal, as Artificial Analysis publishes them, and include the bar itself.
 * A deprecated or unscored model is never a pick, and an unscored session
 * model gets no row. `"session"` keeps the
 * session's own model, which also overrides the cost algorithm. A model the
 * table does not name goes to the cost algorithm (`model-tier.ts`
 * `sameTierContainedCandidates`).
 *
 * The table knows only what existed on PAIRINGS_AS_OF. When the session's
 * provider serves a model of the session's vendor released after that date,
 * the table is skipped for that vendor: a new model may change every pairing,
 * and the algorithm judges it where the table cannot.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { catalogModelFor, isDatedDuplicate } from "./model-catalog.ts";
import { isAliasOrVariantId, modelsContainedToSession, pricedInput, supportsImageInput, vendorProfile } from "./model-policy.ts";
import { isAutoSelectable, type ModelPrice, servedCatalogIds } from "./model-tier.ts";

export type PairingRole = "subagent" | "classifier";

interface PairingRow {
	/** Session models, as catalog ids, all of one vendor. */
	sessions: readonly string[];
	/** A catalog id (`vendor/id`), or SESSION for the session's own model. */
	subagent: string;
	classifier: string;
}

/** The data date: Artificial Analysis (Intelligence Index v5.0.1) and OpenRouter rankings, 2026-11-15. */
export const PAIRINGS_AS_OF = "2026-11-15";

const SESSION = "session";

/**
 * How far below the session model, in Intelligence Index points, a pick may
 * score. The table was built on 15 (subagent, maximum effort) and 7
 * (classifier, low effort) on the earlier index; on the same pairs of
 * models, v5 gaps are about 1.98 times the earlier ones at maximum effort
 * (median of 28 pairs) and about 1.22 times at low effort (median of 9
 * pairs, mean 1.33). The classifier bars are rescaled to keep their
 * strictness:
 * - `classifierLow`: 7 × 1.22 to 1.33, rounded up to 10.
 * - `classifierMax`: the classifier's 7, measured at maximum effort where a
 *   low-effort score is missing, so 7 × 1.98, rounded to 14.
 * - `subagent`: kept at 15, not rescaled. A subagent does real work, and a
 *   pick two tiers below the session returns results that need checking
 *   again; the product warns about such a pick when it is made by hand.
 */
export const PAIRING_BARS = { subagent: 15, classifierLow: 10, classifierMax: 14 } as const;

export const PAIRING_TABLE: readonly PairingRow[] = [
	// Anthropic. Sonnet 5.5 is 10.1 points below Fable 5.2 and 4.6 below Opus 5.5; at low effort it is 9.2 below Opus 5.5,
	// while Fable 5.2's nearest, Opus 5.5, is 19.1 below.
	{ sessions: ["anthropic/claude-fable-5-2"], subagent: "anthropic/claude-sonnet-5-5", classifier: SESSION },
	{ sessions: ["anthropic/claude-opus-5-5"], subagent: "anthropic/claude-sonnet-5-5", classifier: "anthropic/claude-sonnet-5-5" },
	{ sessions: ["anthropic/claude-fable-5-1"], subagent: "anthropic/claude-haiku-5-5", classifier: "anthropic/claude-opus-5-5" },
	{ sessions: ["anthropic/claude-opus-5"], subagent: "anthropic/claude-haiku-5-5", classifier: "anthropic/claude-haiku-5-5" },
	{ sessions: ["anthropic/claude-sonnet-5-5"], subagent: SESSION, classifier: "anthropic/claude-haiku-5-5" },
	{ sessions: ["anthropic/claude-haiku-5-5"], subagent: SESSION, classifier: SESSION },
	// OpenAI. GPT-6.1 Terra is 5.6 points below Astra at a tenth of the price; GPT-6.1 Sol is 8.5 below it at low effort.
	{ sessions: ["openai/gpt-6-astra"], subagent: "openai/gpt-6.1-terra", classifier: "openai/gpt-6.1-sol" },
	{ sessions: ["openai/gpt-6.1-sol", "openai/gpt-6-sol"], subagent: "openai/gpt-6.1-terra", classifier: "openai/gpt-6.1-terra" },
	{ sessions: ["openai/gpt-5.6-terra", "openai/gpt-5.6-luna"], subagent: "openai/gpt-6-luna", classifier: "openai/gpt-6-luna" },
	{ sessions: ["openai/gpt-6.1-terra", "openai/gpt-6-luna"], subagent: SESSION, classifier: SESSION },
	// Google. Gemini 4 Hydrogen is 6.1 below Carbon and above Argon at a lower price; Argon's classifier is the user's call (2026-11-15).
	{ sessions: ["google/gemini-4-carbon"], subagent: "google/gemini-4-hydrogen", classifier: SESSION },
	{ sessions: ["google/gemini-4-argon"], subagent: "google/gemini-4-hydrogen", classifier: "google/gemini-3.8-flash" },
	{ sessions: ["google/gemini-4-hydrogen"], subagent: SESSION, classifier: "google/gemini-3.8-flash" },
	{ sessions: ["google/gemini-3.8-flash"], subagent: SESSION, classifier: SESSION },
	// DeepSeek. V4.1 Flash 1017 outscores V4 Pro by 9.5 points at under a quarter of its price.
	{ sessions: ["deepseek/deepseek-v4-pro-0813"], subagent: "deepseek/deepseek-v4.1-flash-1017", classifier: "deepseek/deepseek-v4.1-flash-1017" },
	{ sessions: ["deepseek/deepseek-v4.1-flash-1017"], subagent: SESSION, classifier: SESSION },
	// Z.ai, Xiaomi, MiniMax, Meta: each vendor's flash model, within 4 points of its larger one or above it.
	{ sessions: ["zhipuai/glm-5.3"], subagent: "zhipuai/glm-5.3-flash", classifier: "zhipuai/glm-5.3-flash" },
	{ sessions: ["zhipuai/glm-5.3-flash"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["xiaomi/mimo-v2.6-pro"], subagent: "xiaomi/mimo-v2.6-flash", classifier: "xiaomi/mimo-v2.6-flash" },
	{ sessions: ["xiaomi/mimo-v2.6-flash"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["minimax/MiniMax-M3"], subagent: "minimax/MiniMax-M3.1-Flash", classifier: "minimax/MiniMax-M3.1-Flash" },
	{ sessions: ["minimax/MiniMax-M3.1-Flash"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["meta/muse-spark-1.3", "meta/muse-spark-open"], subagent: "meta/muse-ember-1.0", classifier: "meta/muse-ember-1.0" },
	// Muse Ember is 7.6 below Muse Wonder; the deprecated Muse Spark 1.3 is never a pick.
	{ sessions: ["meta/muse-wonder-1.0"], subagent: "meta/muse-ember-1.0", classifier: "meta/muse-ember-1.0" },
	{ sessions: ["meta/muse-ember-1.0"], subagent: SESSION, classifier: SESSION },
	// No scored same-vendor model within 15 points: the session model serves both roles.
	{ sessions: ["alibaba/qwen3.8-max-0902"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["moonshotai/kimi-k3.1-pro"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["tencent/hy4"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["xai/grok-4.7"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["stepfun/step-5-preview"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["mistral/mistral-large-4"], subagent: SESSION, classifier: SESSION },
];

const ROW_BY_SESSION: ReadonlyMap<string, PairingRow> = new Map(PAIRING_TABLE.flatMap((row) => row.sessions.map((id) => [id.toLowerCase(), row] as const)));
const AS_OF_TIME = Date.parse(`${PAIRINGS_AS_OF}T23:59:59Z`);

export type Pairing = { kind: "session" } | { kind: "model"; model: Model<Api> };

/**
 * The table's pick for `role` on `sessionModel`, or undefined when the table
 * does not decide: no row names the session model, the session's provider
 * serves a model of its vendor released after PAIRINGS_AS_OF, or no model in
 * the session's contained pool serves the pick, costs no more than the
 * session model on that route, and passes the caller's gates
 * (`requireImageInput`, and `accept`: the classifier's context window). The
 * caller then runs the cost algorithm.
 *
 * Both checks read the pool the cost algorithm starts from (no dated
 * duplicates, only auto-selectable models) but need no price: the table's
 * picks are measured, so they hold on a route with no list prices. Where both
 * are priced, a pick dearer than the session is skipped: a route can price an
 * older model below its successor (OpenRouter's DeepSeek V4 Flash), and an
 * automatic pick never costs more than the session (`price`, list input by
 * default; the classifier passes its per-call price).
 */
export function pairedModel(
	role: PairingRole,
	available: Model<Api>[],
	sessionModel: Model<Api>,
	opts: { contained?: Model<Api>[]; requireImageInput?: boolean; price?: ModelPrice; accept?: (model: Model<Api>) => boolean } = {},
): Pairing | undefined {
	const sessionEntry = catalogModelFor(sessionModel);
	const row = sessionEntry && ROW_BY_SESSION.get(sessionEntry.id.toLowerCase());
	if (!sessionEntry || !row) return undefined;
	const pool = opts.contained ?? modelsContainedToSession(available, sessionModel);
	const served = servedCatalogIds(pool);
	const selectable = pool.filter((model) => isAutoSelectable(model, served));
	// The table predates this vendor's newest model: it no longer speaks for the
	// vendor. A new dated snapshot counts, even beside the undated alias.
	const vendor = vendorProfile(sessionEntry.vendor);
	const newer = selectable.some((model) => {
		const entry = catalogModelFor(model);
		return entry !== undefined && vendorProfile(entry.vendor) === vendor && entry.released !== undefined && entry.released > AS_OF_TIME;
	});
	if (newer) return undefined;
	const usable = selectable.filter((model) => !isDatedDuplicate(model, pool));
	const pick = row[role];
	if (pick === SESSION) return { kind: "session" };
	const wanted = pick.toLowerCase();
	const accept = opts.accept ?? (() => true);
	const priceOf = opts.price ?? pricedInput;
	const sessionPrice = priceOf(sessionModel);
	const notDearer = (model: Model<Api>) => {
		const price = priceOf(model);
		return sessionPrice === undefined || price === undefined || price <= sessionPrice;
	};
	const serving = usable
		.filter(
			(model) =>
				catalogModelFor(model)?.id.toLowerCase() === wanted &&
				(!opts.requireImageInput || supportsImageInput(model)) &&
				notDearer(model) &&
				accept(model),
		)
		// A plain row before a gateway variant (`…:batch`) of the same model.
		.sort((a, b) => Number(isAliasOrVariantId(a.id)) - Number(isAliasOrVariantId(b.id)) || a.id.length - b.id.length);
	return serving[0] ? { kind: "model", model: serving[0] } : undefined;
}

/**
 * The model pairing table (pure): for the models people run most, which model
 * a session hands its subagents and its auto-mode classifier. Each row comes
 * from measured data, not from tiers or price alone: Artificial Analysis's
 * Intelligence Index (maximum effort for subagents; low effort for the
 * classifier, which runs with thinking off) and list prices, with OpenRouter's
 * usage rankings choosing which models get a row. The snapshot and the numbers
 * behind every row are in `working-docs/decisions/model-policy.md` ("Model
 * pairing table").
 *
 * A pick is the cheapest same-vendor model within 15 points at maximum effort
 * (subagent) or 7 points at low effort (classifier); `"session"` keeps the
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
import { catalogModelFor } from "./model-catalog.ts";
import { isAliasOrVariantId, isDatedDuplicate, modelsContainedToSession, pricedInput, supportsImageInput, vendorProfile } from "./model-policy.ts";
import { isAutoSelectable, type ModelPrice, servedCatalogIds } from "./model-tier.ts";

export type PairingRole = "subagent" | "classifier";

interface PairingRow {
	/** Session models, as catalog ids, all of one vendor. */
	sessions: readonly string[];
	/** A catalog id (`vendor/id`), or SESSION for the session's own model. */
	subagent: string;
	classifier: string;
}

/** The data date: Artificial Analysis and OpenRouter rankings, 2026-10-13. */
export const PAIRINGS_AS_OF = "2026-10-13";

const SESSION = "session";

export const PAIRING_TABLE: readonly PairingRow[] = [
	// Anthropic. Sonnet 5.5 is within 2 points of Opus 5.5 at half the price and above Fable 5.1.
	{
		sessions: ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic/claude-opus-4-8", "anthropic/claude-fable-5", "anthropic/claude-fable-5-1"],
		subagent: "anthropic/claude-sonnet-5-5",
		classifier: "anthropic/claude-sonnet-5-5",
	},
	{ sessions: ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5"], subagent: "anthropic/claude-haiku-5-5", classifier: "anthropic/claude-haiku-5-5" },
	{ sessions: ["anthropic/claude-haiku-5-5"], subagent: SESSION, classifier: SESSION },
	// OpenAI. GPT-6.1 Sol is within a point of Astra at a fifth of the price; Luna drops 20 points at low effort.
	{ sessions: ["openai/gpt-6-astra"], subagent: "openai/gpt-6.1-sol", classifier: "openai/gpt-6.1-sol" },
	{ sessions: ["openai/gpt-6.1-sol", "openai/gpt-6-sol"], subagent: "openai/gpt-6-luna", classifier: SESSION },
	{ sessions: ["openai/gpt-5.6-sol"], subagent: "openai/gpt-6.1-sol", classifier: "openai/gpt-6.1-sol" },
	{ sessions: ["openai/gpt-5.6-terra", "openai/gpt-5.6-luna"], subagent: "openai/gpt-6-luna", classifier: "openai/gpt-6-luna" },
	{ sessions: ["openai/gpt-6-luna"], subagent: SESSION, classifier: SESSION },
	// Google. Gemini 3.8 Flash outscores 3.1 Pro; Argon's classifier pick is the user's call (2026-10-13).
	{
		sessions: ["google/gemini-4-argon", "google/gemini-3.1-pro-preview", "google/gemini-3.7-flash", "google/gemini-3.6-flash", "google/gemini-3.5-flash"],
		subagent: "google/gemini-3.8-flash",
		classifier: "google/gemini-3.8-flash",
	},
	{ sessions: ["google/gemini-3.8-flash"], subagent: SESSION, classifier: SESSION },
	// DeepSeek. V4.1 Flash outscores V4 Pro at under a quarter of its price.
	{
		sessions: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-0731"],
		subagent: "deepseek/deepseek-v4.1-flash",
		classifier: "deepseek/deepseek-v4.1-flash",
	},
	{ sessions: ["deepseek/deepseek-v4.1-flash"], subagent: SESSION, classifier: SESSION },
	// Z.ai, Xiaomi, Qwen: each vendor's flash model.
	{ sessions: ["zhipuai/glm-5.3"], subagent: "zhipuai/glm-5.3-flash", classifier: "zhipuai/glm-5.3-flash" },
	{ sessions: ["zhipuai/glm-5.3-flash"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["xiaomi/mimo-v2.6-pro"], subagent: "xiaomi/mimo-v2.6-flash", classifier: SESSION },
	{ sessions: ["xiaomi/mimo-v2.6-flash"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["alibaba/qwen3.8-max", "alibaba/qwen3.8-max-0902"], subagent: "alibaba/qwen3.8-flash", classifier: "alibaba/qwen3.8-flash" },
	{ sessions: ["alibaba/qwen3.8-flash"], subagent: SESSION, classifier: SESSION },
	// No same-vendor model within 15 points: the session model serves both roles.
	{ sessions: ["moonshotai/kimi-k3"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["xai/grok-4.7"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["meta/muse-spark-1.3"], subagent: SESSION, classifier: SESSION },
	{ sessions: ["minimax/MiniMax-M3"], subagent: SESSION, classifier: SESSION },
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

/**
 * Choosing the classifier model (pure).
 *
 * ## Why this is not just "pick a cheap model"
 *
 * The classifier receives the user's own messages, their CLAUDE.md, and the text
 * of the command being judged. So *which provider it runs on* is a privacy
 * decision, not an optimisation. The first cut of this searched the whole
 * registry for a model whose id contained "haiku"/"sonnet"/"mini", which on a
 * session running `openai-codex/gpt-5.5-codex` with an Anthropic key also present
 * silently selected `anthropic/claude-haiku-4-5` — shipping that user's prompts to
 * a vendor they had not chosen for this session, through a component with no UI.
 *
 * So: **never leave the session's provider unless the user asked for it.** An
 * explicit `autoMode.classifierModel` may name any provider, because naming it is
 * the asking. Everything else stays where the session already is. This is the same
 * reasoning pi's own subagent config gives for defaulting to the session model —
 * "this keeps new installs from depending on a provider you may not have
 * configured" — and this module follows that precedence shape: explicit override,
 * then a configured default, then something sensible in-provider, then the session
 * model itself.
 *
 * Name matching is demoted to a tiebreak because it does not survive contact with
 * real catalogs: of Groq's 7 models and xAI's 3, *none* contain any of those
 * substrings, while OpenRouter has 303 models and 79 substring hits, so the "first
 * match" is arbitrary. Cost is the one signal every provider carries.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Providers that are *routers*: the pi provider is the gateway, and the model id
 * carries the upstream vendor that actually receives the request
 * (`anthropic/claude-haiku-4.5` on OpenRouter is served by Anthropic).
 *
 * This distinction is why staying on the same pi provider is not enough. A
 * session on `openai/gpt-5.1` through OpenRouter screened by
 * `anthropic/claude-haiku-4.5` keeps one set of credentials but sends the user's
 * messages and CLAUDE.md to Anthropic — a vendor they did not pick. Same class of
 * leak as the original cross-provider bug, one level down.
 *
 * Groq, Bedrock and GitHub Copilot also carry vendor-ish prefixes
 * (`meta-llama/…`, `anthropic.claude-…`) but *host* those weights themselves, so
 * the data goes to them regardless and no vendor matching is needed.
 */
const GATEWAY_PROVIDERS = new Set(["openrouter", "vercel-ai-gateway", "cloudflare-ai-gateway"]);

/**
 * Known-good cheap classifiers per vendor, in preference order. Prefixes, so a
 * dated variant (`claude-haiku-4-5-20251001`) satisfies `claude-haiku-4-5`.
 *
 * These sit at the small-but-capable tier — mini/haiku/flash — rather than the
 * absolute cheapest tier (nano, flash-lite). A classifier is a security boundary,
 * and Claude Code runs its own on a Sonnet-class model; dropping to the very
 * bottom to save a fraction of a cent trades away the judgement the gate exists
 * for. Anyone who wants that trade can name it in `autoMode.classifierModel`.
 *
 * Flagship models are deliberately absent (bar Anthropic's Sonnet, which is what
 * Claude Code itself uses): an entry matching the session's own model would make
 * the table "choose" the very model it exists to find something cheaper than.
 */
export const VENDOR_CLASSIFIERS: Record<string, string[]> = {
	anthropic: ["claude-haiku-4.5", "claude-haiku-4-5", "claude-3-5-haiku", "claude-sonnet-5"],
	openai: ["gpt-5-mini", "gpt-5.1-mini", "gpt-4.1-mini", "gpt-4o-mini"],
	google: ["gemini-2.5-flash", "gemini-2.0-flash"],
	"meta-llama": ["llama-3.3-70b", "llama-4-scout"],
	mistralai: ["mistral-small", "mistral-medium"],
	deepseek: ["deepseek-chat"],
	qwen: ["qwen3-30b", "qwen-plus"],
	"z-ai": ["glm-4.5-air", "glm-4-flash"],
	"x-ai": ["grok-3-mini", "grok-4.3"],
	moonshotai: ["kimi-k2"],
};

/**
 * Same table keyed by pi provider, for direct providers where the provider *is*
 * the vendor. Kept separate because a few provider names differ from the vendor
 * name, and a few providers host other vendors' weights themselves.
 */
export const PROVIDER_DEFAULT_CLASSIFIERS: Record<string, string[]> = {
	anthropic: VENDOR_CLASSIFIERS.anthropic,
	openai: VENDOR_CLASSIFIERS.openai,
	"openai-codex": ["gpt-5-mini", "gpt-5.1-codex-mini", "gpt-5.5-codex"],
	google: VENDOR_CLASSIFIERS.google,
	"google-vertex": VENDOR_CLASSIFIERS.google,
	groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
	xai: VENDOR_CLASSIFIERS["x-ai"],
	deepseek: VENDOR_CLASSIFIERS.deepseek,
	mistral: VENDOR_CLASSIFIERS.mistralai,
	"amazon-bedrock": ["anthropic.claude-haiku", "us.anthropic.claude-haiku"],
	"github-copilot": ["gpt-5-mini", "claude-haiku-4.5"],
};

/** The upstream vendor a model id names, for gateway providers only. */
export function vendorOf(model: Model<Api>): string | undefined {
	if (!GATEWAY_PROVIDERS.has(model.provider)) return undefined;
	const slash = model.id.indexOf("/");
	return slash > 0 ? model.id.slice(0, slash) : undefined;
}

/**
 * Names of the known small-but-capable model families. Too weak to *choose* by —
 * Groq and xAI carry none of them — but strong enough to corroborate a choice
 * price alone suggested. See the cheapest-in-provider ordering below.
 */
const NAME_HINTS = [/haiku/i, /flash/i, /mini/i, /nano/i, /small/i, /lite/i, /instant/i, /sonnet/i];

/**
 * Model-id suffixes that cannot serve as a synchronous per-call gate, and which
 * are *systematically cheaper*, so a cost-ranked search actively prefers them:
 *
 * - `:batch` is an asynchronous endpoint — a blocking classifier call would wait
 *   out its timeout and then block the tool call. OpenRouter lists
 *   `anthropic/claude-haiku-4.5:batch` at half the price of the plain model.
 * - `:free` is rate-limited hard enough that a gate on it fails intermittently,
 *   and an intermittently-failing gate blocks real work.
 * - `:online` bolts web search onto every call; `:thinking` forces reasoning we
 *   deliberately disable. Both are the wrong shape and cost more.
 *
 * Only automatic selection is filtered. An explicit `autoMode.classifierModel`
 * still wins, because naming a model is choosing it.
 */
const UNSUITABLE_VARIANT = /:(batch|free|online|thinking)$/i;

function isSelectableVariant(model: Model<Api>): boolean {
	return !UNSUITABLE_VARIANT.test(model.id);
}

/**
 * A usable price. Non-positive costs are not "free", they are unpriced: pi carries
 * `-1000000` for OpenRouter's router pseudo-models and `0` for free-tier entries,
 * and both would win a cheapest-first sort while telling us nothing about
 * suitability.
 */
function pricedInput(model: Model<Api>): number | undefined {
	const input = model.cost?.input;
	return typeof input === "number" && input > 0 ? input : undefined;
}

function hintRank(model: Model<Api>): number {
	const index = NAME_HINTS.findIndex((pattern) => pattern.test(model.id));
	return index === -1 ? NAME_HINTS.length : index;
}

export interface Candidate {
	model: Model<Api>;
	/** How this candidate was arrived at, for the notice shown to the user. */
	source: "configured" | "provider-default" | "cheapest-in-provider" | "session";
}

/**
 * First model matching one of `prefixes` in order, optionally constrained.
 * Walking the whole list rather than stopping at the first *prefix* is what lets
 * a table entry be skipped when it fails the constraint — a dearer default falls
 * through to the next entry instead of being used anyway.
 */
function findByPrefix(
	models: Model<Api>[],
	prefixes: string[],
	accept: (model: Model<Api>) => boolean = () => true,
): Model<Api> | undefined {
	for (const prefix of prefixes) {
		const candidates = models.filter((model) => model.id === prefix || model.id.startsWith(prefix));
		const exact = candidates.find((model) => model.id === prefix && accept(model));
		if (exact) return exact;
		const prefixed = candidates.find(accept);
		if (prefixed) return prefixed;
	}
	return undefined;
}

/** Resolve an explicit `provider/model-id`, a bare id, or undefined. */
export function findConfigured(available: Model<Api>[], configured: string): Model<Api> | undefined {
	const wanted = configured.trim();
	if (!wanted) return undefined;
	const qualified = available.find((model) => `${model.provider}/${model.id}` === wanted);
	if (qualified) return qualified;
	const byId = available.find((model) => model.id === wanted);
	if (byId) return byId;
	// `provider/prefix` — accept a dated or suffixed variant of what was named.
	const slash = wanted.indexOf("/");
	if (slash > 0) {
		const provider = wanted.slice(0, slash);
		const idPrefix = wanted.slice(slash + 1);
		const inProvider = available.filter((model) => model.provider === provider);
		const match = findByPrefix(inProvider, [idPrefix]);
		if (match) return match;
	}
	return available.find((model) => model.id.startsWith(wanted));
}

export interface SelectInput {
	/** Models the user actually has working credentials for. */
	available: Model<Api>[];
	sessionModel: Model<Api> | undefined;
	/** `autoMode.classifierModel`, if set. May name any provider. */
	configured?: string;
}

/**
 * The ordered candidate chain. More than one is returned so a candidate that
 * turns out to be unusable at call time (not entitled on this account, withdrawn
 * by the provider) can be stepped over instead of failing every tool call — the
 * same shape as pi's subagent `fallbackModels`.
 *
 * The chain always ends at the session model when there is one, so auto mode
 * degrades to "correct but not cheap" rather than to "broken".
 */
export function classifierCandidates({ available, sessionModel, configured }: SelectInput): Candidate[] {
	const candidates: Candidate[] = [];
	const push = (model: Model<Api> | undefined, source: Candidate["source"]) => {
		if (!model) return;
		if (candidates.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id)) return;
		candidates.push({ model, source });
	};

	// 1. What the user asked for, wherever it lives. Naming a provider is choosing it.
	if (configured) push(findConfigured(available, configured), "configured");

	const provider = sessionModel?.provider;
	/**
	 * On a gateway, "same provider" is not containment — the upstream vendor in the
	 * model id is who actually receives the prompt — so candidacy is narrowed to
	 * the session's own vendor as well. When that vendor offers nothing cheaper,
	 * the session model screens the calls rather than the prompt going to a
	 * different vendor to save a fraction of a cent.
	 */
	const vendor = sessionModel ? vendorOf(sessionModel) : undefined;
	const inProvider = provider
		? available.filter(
				(model) =>
					model.provider === provider &&
					isSelectableVariant(model) &&
					(vendor === undefined || vendorOf(model) === vendor),
			)
		: [];

	/**
	 * No candidate may cost more per token than the model doing the actual work.
	 * Screening a call more expensively than making it is indefensible, and it
	 * happened: on an OpenRouter session at `z-ai/glm-4.6` ($0.50/M) the table's
	 * `anthropic/claude-haiku-4.5` ($1/M) was selected, because this ceiling was
	 * originally applied only to the cost-ranked branch and not to the table.
	 */
	const sessionPrice = sessionModel ? pricedInput(sessionModel) : undefined;
	const withinBudget = (model: Model<Api>) => {
		if (sessionPrice === undefined) return true;
		const price = pricedInput(model);
		return price === undefined || price <= sessionPrice;
	};

	// 2. A known-good cheap model for this vendor, for catalogs where price alone
	//    picks badly. Entries are tried in order, so one that busts the budget
	//    falls through to the next rather than being used anyway.
	if (provider) {
		// On a gateway the table is keyed by vendor and the ids carry the prefix.
		const families = vendor
			? (VENDOR_CLASSIFIERS[vendor] ?? []).map((family) => `${vendor}/${family}`)
			: (PROVIDER_DEFAULT_CLASSIFIERS[provider] ?? []);
		push(findByPrefix(inProvider, families, withinBudget), "provider-default");
	}

	// 3. The cheapest genuinely-priced model in the provider.
	const cheaper = inProvider
		.map((model) => ({ model, price: pricedInput(model) }))
		.filter((entry): entry is { model: Model<Api>; price: number } => entry.price !== undefined)
		.filter((entry) => withinBudget(entry.model))
		.sort((a, b) => a.price - b.price || hintRank(a.model) - hintRank(b.model));
	const cheapest = cheaper[0]?.model;

	/**
	 * 4. The session's own model, ahead of the cost-ranked pick.
	 *
	 * Price is not evidence of suitability, and a name is barely better. On
	 * OpenRouter the cheapest model in the catalog is `inclusionai/ling-2.6-flash`
	 * at $0.01/M, which would otherwise become the security boundary for being
	 * cheap. An attempt to gate that on the name carrying a known small-model word
	 * failed on the same example — "flash" is in the name, because any vendor may
	 * put it there; the word means "someone called this small", not "this family is
	 * known good".
	 *
	 * So nothing chosen on price alone leads. Providers that *are* vetted get their
	 * saving from the table above (which covers OpenRouter and every mainstream
	 * provider); anywhere else the model the user already trusted for the real work
	 * screens the calls — correct, merely not cheap — and `classifierModel` is
	 * there for someone who wants otherwise.
	 */
	push(sessionModel, "session");

	// 5. Last resort, for when even the session model cannot serve.
	push(cheapest, "cheapest-in-provider");

	// Nothing configured and no session model (a headless run with a bare
	// registry) — take anything available rather than refusing outright.
	if (candidates.length === 0) push(available[0], "session");

	return candidates;
}

/**
 * Whether an error means "this model is not usable on this account" — in which
 * case stepping to the next candidate is right — as opposed to a transient
 * failure, where switching models would hide a problem that is about to clear.
 */
export function isModelUnavailableError(message: string): boolean {
	return /\b(401|403|404)\b|not_found|not found|does not exist|(no|have|lacks?)\s+access|unauthoriz|forbidden|invalid[_ -]?model|model[_ -]?not|unsupported[_ -]?model|no such model|entitl|quota|insufficient[_ -]?quota/i.test(
		message,
	);
}

/** One-line description for the notice and `/auto-mode config`. */
export function describeCandidate(candidate: Candidate): string {
	const name = `${candidate.model.provider}/${candidate.model.id}`;
	switch (candidate.source) {
		case "configured":
			return `${name} (from autoMode.classifierModel)`;
		case "provider-default":
			return `${name} (default for this provider)`;
		case "cheapest-in-provider": {
			const where = vendorOf(candidate.model) ?? candidate.model.provider;
			return `${name} (cheapest available from ${where})`;
		}
		case "session": {
			const where = vendorOf(candidate.model) ?? candidate.model.provider;
			return `${name} (this session's model — nothing cheaper from ${where})`;
		}
	}
}

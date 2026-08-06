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
 * Known-good cheap classifiers per provider, for catalogs where cost alone picks
 * badly. OpenRouter is the motivating case: sorting its 303 models by price puts
 * `openrouter/auto` first at a *negative* sentinel price, and Google's free-tier
 * entries sit at `$0`, so "cheapest" is not a usable answer there.
 *
 * Matched as a prefix against the model id, so a dated variant
 * (`claude-haiku-4-5-20251001`) satisfies `claude-haiku-4-5`.
 */
export const PROVIDER_DEFAULT_CLASSIFIERS: Record<string, string[]> = {
	anthropic: ["claude-haiku-4-5", "claude-sonnet-5"],
	openrouter: ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini", "google/gemini-2.5-flash"],
	openai: ["gpt-5-mini", "gpt-5-nano", "gpt-4.1-mini"],
	"openai-codex": ["gpt-5-mini", "gpt-5.5-codex"],
	google: ["gemini-2.5-flash", "gemini-2.0-flash"],
	"google-vertex": ["gemini-2.5-flash", "gemini-2.0-flash"],
	groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
	xai: ["grok-4.3"],
	deepseek: ["deepseek-chat"],
	mistral: ["mistral-small-latest"],
	"amazon-bedrock": ["anthropic.claude-haiku", "us.anthropic.claude-haiku"],
	"vercel-ai-gateway": ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini"],
	"github-copilot": ["gpt-5-mini", "claude-haiku-4.5"],
};

/** Weak hints, used only to break ties between equally-priced candidates. */
const NAME_HINTS = [/haiku/i, /flash/i, /mini/i, /nano/i, /small/i, /lite/i, /instant/i, /sonnet/i];

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

function findByPrefix(models: Model<Api>[], prefixes: string[]): Model<Api> | undefined {
	for (const prefix of prefixes) {
		const exact = models.find((model) => model.id === prefix);
		if (exact) return exact;
		const prefixed = models.find((model) => model.id.startsWith(prefix));
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
	const inProvider = provider ? available.filter((model) => model.provider === provider) : [];

	// 2. A known-good cheap model for this provider, for catalogs where price
	//    alone picks badly.
	if (provider) push(findByPrefix(inProvider, PROVIDER_DEFAULT_CLASSIFIERS[provider] ?? []), "provider-default");

	// 3. The cheapest genuinely-priced model in the same provider that is no more
	//    expensive than the session's own model — there is no point paying more to
	//    screen a call than to make it.
	const sessionPrice = sessionModel ? pricedInput(sessionModel) : undefined;
	const cheaper = inProvider
		.map((model) => ({ model, price: pricedInput(model) }))
		.filter((entry): entry is { model: Model<Api>; price: number } => entry.price !== undefined)
		.filter((entry) => sessionPrice === undefined || entry.price <= sessionPrice)
		.sort((a, b) => a.price - b.price || hintRank(a.model) - hintRank(b.model));
	push(cheaper[0]?.model, "cheapest-in-provider");

	// 4. The session's own model: always correct, just not cheap.
	push(sessionModel, "session");

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
		case "cheapest-in-provider":
			return `${name} (cheapest available on ${candidate.model.provider})`;
		case "session":
			return `${name} (this session's model — no cheaper one found on ${candidate.model.provider})`;
	}
}

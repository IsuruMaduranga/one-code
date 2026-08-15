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

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	findConfigured,
	findRoleProfileModel,
	hintRank,
	modelIdentity,
	modelsContainedToSession,
	pricedInput,
} from "../lib/model-policy.ts";

export { findConfigured } from "../lib/model-policy.ts";

export interface Candidate {
	model: Model<Api>;
	/** How this candidate was arrived at, for the notice shown to the user. */
	source: "configured" | "role-profile" | "cheapest-in-provider" | "session";
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

	/**
	 * Containment is shared with subagents. For a direct provider it is the
	 * provider itself; gateways additionally preserve a reliable route/family;
	 * opaque routers expose only the session model.
	 */
	const inProvider = sessionModel ? modelsContainedToSession(available, sessionModel) : [];

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

	// 2. A reviewed small-but-capable model for this provider/family. The
	//    profile is short and applied to the live catalog; price alone never
	//    promotes a model into the classifier role.
	if (sessionModel) {
		// Reuse the containment set computed above instead of recomputing it inside.
		push(findRoleProfileModel(available, sessionModel, "classifier", withinBudget, inProvider), "role-profile");
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
 *
 * "Quota" is deliberately matched only in its billing forms (`insufficient_quota`,
 * "exceeded your current quota"): a bare match also caught per-minute rate-limit
 * messages ("quota exceeded, retry in 60s"), permanently rejecting a healthy
 * model for the whole session over a blip. Misreading billing as transient
 * merely retries and blocks noisily; misreading a blip as permanent bricks the
 * candidate — so uncertainty goes to transient.
 */
export function isModelUnavailableError(message: string): boolean {
	return /\b(401|403|404)\b|not_found|not found|does not exist|(no|have|lacks?)\s+access|unauthoriz|forbidden|invalid[_ -]?model|model[_ -]?not|unsupported[_ -]?model|no such model|entitl|insufficient[_ -]?quota|exceeded your current quota|billing/i.test(
		message,
	);
}

/** One-line description for the notice and `/auto-mode config`. */
export function describeCandidate(candidate: Candidate): string {
	const name = `${candidate.model.provider}/${candidate.model.id}`;
	switch (candidate.source) {
		case "configured":
			return `${name} (from autoMode.classifierModel)`;
		case "role-profile": {
			const where = modelIdentity(candidate.model).profile ?? candidate.model.provider;
			return `${name} (classifier profile for ${where})`;
		}
		case "cheapest-in-provider": {
			const where = modelIdentity(candidate.model).profile ?? candidate.model.provider;
			return `${name} (cheapest available within ${where})`;
		}
		case "session": {
			const where = modelIdentity(candidate.model).profile ?? candidate.model.provider;
			return `${name} (this session's model — no vetted smaller model within ${where})`;
		}
	}
}

/** Concatenated text blocks of a one-shot reply (classifier verdicts, setup drafts). */
export function replyText(reply: AssistantMessage): string {
	return reply.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Some pi builds resolve a per-provider baseUrl alongside the API key; it is
 * not in every published version of the auth type, so it is read defensively
 * and, when present, carried onto the model for the call.
 */
export function withAuthBaseUrl(model: Model<Api>, auth: unknown): Model<Api> {
	const baseUrl = (auth as { baseUrl?: string }).baseUrl;
	return baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model;
}

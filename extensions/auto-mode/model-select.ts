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
 * So: **never leave the session's provider or route.** Automatic selection uses
 * only contained models. It also requires a catalog context window at least as
 * large as the session's, because the classifier receives the full transcript;
 * if that cannot be proved, it screens on the session model instead. And it
 * never screens with a model in a lower tier than the session's, or one that is
 * not strictly cheaper (a tie keeps the session).
 *
 * An explicit `autoMode.classifierModel` may name any provider, because naming
 * it is choosing it: it leads the chain, with notices for a cross-provider
 * choice and warnings for what it costs (`lib/model-choice-warnings.ts`).
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { type ChosenModelWarning, chosenModelWarnings } from "../lib/model-choice-warnings.ts";
import { crossesProvider, findConfigured, isStaleContainmentStamp, modelIdentity, modelSpec as spec, pricedInput } from "../lib/model-policy.ts";
import { atLeastTier, economicalContainedCandidates, intrinsicTier } from "../lib/model-tier.ts";

export interface Candidate {
	model: Model<Api>;
	/** How this candidate was arrived at, for the notice shown to the user. */
	source: "configured" | "economical" | "session";
}

export interface SelectInput {
	/** Models the user actually has working credentials for. */
	available: Model<Api>[];
	sessionModel: Model<Api> | undefined;
	/** `autoMode.classifierModel`, if set. May name any provider. */
	configured?: string;
	/**
	 * The containment identity the `classifierModel` setting was stamped for by
	 * `/auto-mode model`. When it differs from this session's, a cross-provider
	 * setting is stale (set for a session since left) and is replaced, with a
	 * warning. Undefined for a hand-edited setting.
	 */
	configuredSetForContainment?: string;
}

/** Why automatic selection had to keep the session model. */
export type ClassifierFallbackReason = "unknown-session-context-window" | "no-qualifying-model" | "session-is-cheapest-qualified";

/** Structured selection fallback, retained with the chain for permission UI and logging. */
export interface ClassifierFallback {
	reason: ClassifierFallbackReason;
	text: string;
}

/** A user-facing selection notice, tagged so an informational one is not shown as a warning. */
export interface ClassifierNotice {
	level: "info" | "warning";
	text: string;
	/** Present for a session fallback, so renderers need not parse `text`. */
	fallbackReason?: ClassifierFallbackReason;
	/** Present for a warning about the user's chosen classifier (`lib/model-choice-warnings.ts`). */
	choiceWarning?: ChosenModelWarning["kind"];
}

export interface ClassifierChain {
	candidates: Candidate[];
	notices: ClassifierNotice[];
	fallback?: ClassifierFallback;
}

/**
 * The ordered fallback chain for the permission classifier. The user's
 * `autoMode.classifierModel` leads when it resolves and is not stale; its
 * warnings ride the notices. Then the automatic chain
 * (`automaticClassifierCandidates`), which ends at the session model.
 */
export function classifierCandidates({ available, sessionModel, configured, configuredSetForContainment }: SelectInput): ClassifierChain {
	const automatic = automaticClassifierCandidates(available, sessionModel);
	if (!configured) return automatic;
	const resolved = findConfigured(available, configured);
	if (!resolved) {
		return {
			...automatic,
			notices: [
				{
					level: "warning",
					text: `autoMode.classifierModel ${configured} is not an available model (unknown id, or no credentials for its provider); auto mode chooses automatically instead.`,
				},
				...automatic.notices,
			],
		};
	}
	const notices: ClassifierNotice[] = [];
	if (sessionModel && crossesProvider(resolved, sessionModel)) {
		// Naming a provider is choosing it, but a setting stamped for a provider
		// this session has since left is stale (parity with the subagent setting).
		if (isStaleContainmentStamp(configuredSetForContainment, sessionModel)) {
			return {
				...automatic,
				notices: [
					{
						level: "warning",
						text:
							`autoMode.classifierModel ${spec(resolved)} was set for a different provider than this session (${spec(sessionModel)}); ` +
							"a same-provider model screens calls instead. Re-set it with /auto-mode model on this session to use it here.",
					},
					...automatic.notices,
				],
			};
		}
		// Informational: the user chose this for this session.
		notices.push({
			level: "info",
			text:
				`autoMode.classifierModel ${spec(resolved)} is a different provider than this session (${spec(sessionModel)}): ` +
				"it reads your messages and CLAUDE.md, so those go to that provider. It was set for this session, so it is used.",
		});
	}
	for (const warning of chosenModelWarnings({ available, sessionModel, chosen: resolved, role: "classifier" })) {
		notices.push({ level: "warning", text: `${warning.text} ${warning.fix}`, choiceWarning: warning.kind });
	}
	const candidates: Candidate[] = [{ model: resolved, source: "configured" }];
	for (const entry of automatic.candidates) {
		if (entry.model.provider !== resolved.provider || entry.model.id !== resolved.id) candidates.push(entry);
	}
	// The automatic chain's "why the session screens" notice does not describe a
	// chain the user's choice leads, so it is dropped with its fallback.
	return { candidates, notices };
}

/**
 * The automatic chain. Entries stay on the session provider/route, sit in the
 * session's tier or above (`model-tier.ts`, from the public catalogs), cost
 * strictly less than the session model, are not experimental builds, and have
 * a known catalog window at least as large as the session's: the same rule as
 * the subagent default (`sameTierContainedCandidates`) plus the window. The
 * cheapest qualifying model screens first, with the session retained as an
 * availability fallback.
 */
function automaticClassifierCandidates(available: Model<Api>[], sessionModel: Model<Api> | undefined): ClassifierChain {
	const candidates: Candidate[] = [];
	const notices: ClassifierNotice[] = [];
	const push = (model: Model<Api> | undefined, source: Candidate["source"]) => {
		if (!model) return;
		if (candidates.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id)) return;
		candidates.push({ model, source });
	};

	// A classifier gets the whole user transcript. It must stay on the session's
	// provider/route, sit in the session's tier, and be able to receive every
	// token the session catalog says the main model can receive. Catalog
	// omissions are unsafe to guess at: an unknown candidate window is ineligible.
	if (!sessionModel) return { candidates, notices };
	if (!hasCatalogContextWindow(sessionModel)) {
		const fallback: ClassifierFallback = {
			reason: "unknown-session-context-window",
			text: `Auto mode is screening calls with ${spec(sessionModel)}, this session's model, because its catalog context window is unknown and no alternate classifier can be verified to contain it.`,
		};
		push(sessionModel, "session");
		notices.push({ level: "info", text: fallback.text, fallbackReason: fallback.reason });
		return { candidates, notices, fallback };
	}

	const sessionTier = intrinsicTier(sessionModel);
	const sessionPrice = pricedInput(sessionModel);
	const isSession = (model: Model<Api>) => model.provider === sessionModel.provider && model.id === sessionModel.id;
	// Never weaker than the session: no point screening a model with a weaker one.
	// Strictly cheaper, else the session (the user, 2026-10-05: Qwen 3.8 27B drew
	// a 2.4T model at five times its input price; 2026-10-07: a same-price older
	// model saves nothing); an unpriced session cannot prove an alternate
	// cheaper. Never an experimental build. A catalog window that contains the
	// session's.
	const screenable = (model: Model<Api>) =>
		atLeastTier(intrinsicTier(model), sessionTier) &&
		sessionPrice !== undefined &&
		(isSession(model) || pricedInput(model)! < sessionPrice) &&
		!EXPERIMENTAL_BUILD.test(model.id) &&
		hasCatalogContextWindow(model) &&
		model.contextWindow >= sessionModel.contextWindow;
	// `economicalContainedCandidates` supplies the containment, variant, catalog
	// (current, tool-calling, text), price-known and never-tiny gates. Its own
	// cheap/workhorse/frontier ordering is replaced below: this policy selects the
	// numerically cheapest model that clears those gates.
	const eligible = economicalContainedCandidates(available, sessionModel).filter(screenable);
	// A catalog normally includes the active model, but the active row is also a
	// valid choice when it is absent from a stale catalog. A tiny or unpriced
	// session remains only the terminal fallback.
	if (sessionTier !== "tiny" && sessionPrice !== undefined && !eligible.some(isSession)) eligible.push(sessionModel);
	eligible.sort((a, b) => pricedInput(a)! - pricedInput(b)!);
	for (const model of eligible) push(model, isSession(model) ? "session" : "economical");
	const fallbackText = `Auto mode is screening calls with ${spec(sessionModel)}, this session's model, because no cheaper same-provider/route model in its ${sessionTier} tier or above contains its ${sessionModel.contextWindow}-token catalog context window.`;
	if (candidates.length > 0) {
		// The startup notice needs a reason even when the session was eligible in
		// its own right: otherwise a renderer cannot distinguish "no alternate can
		// contain the transcript" from "the session is simply the cheapest choice".
		if (candidates[0].source === "session") {
			const fallback: ClassifierFallback = {
				reason: candidates.length > 1 ? "session-is-cheapest-qualified" : "no-qualifying-model",
				text: fallbackText,
			};
			notices.push({ level: "info", text: fallback.text, fallbackReason: fallback.reason });
			return { candidates, notices, fallback };
		}
		// Always retain the session as the final availability fallback. It is not an
		// automatic selection candidate, so its own catalog-window metadata need not
		// be rediscovered here.
		push(sessionModel, "session");
		return { candidates, notices };
	}

	const fallback: ClassifierFallback = { reason: "no-qualifying-model", text: fallbackText };
	push(sessionModel, "session");
	notices.push({ level: "info", text: fallback.text, fallbackReason: fallback.reason });
	return { candidates, notices, fallback };
}

/**
 * An experimental build (`deepseek-v4-flash-vision-exp`, `tev1-4b-experimental`):
 * a research variant, not the release a permission gate should run on.
 * `preview` is deliberately not matched: Google ships mainline Gemini models
 * under it (`gemini-3-flash-preview`).
 */
const EXPERIMENTAL_BUILD = /-exp(?:$|[-:])|experimental/i;

/** A positive finite catalog window is the only value safe for automatic routing. */
function hasCatalogContextWindow(model: Model<Api>): model is Model<Api> & { contextWindow: number } {
	return Number.isFinite(model.contextWindow) && model.contextWindow > 0;
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
 *
 * "not supported" is here because a plan/entitlement refusal is often phrased
 * that way rather than as a 403: Codex answers a classifier call on
 * `gpt-5.3-codex-spark` with "The 'gpt-5.3-codex-spark' model is not supported
 * when using Codex with a ChatGPT account." Without the match that read as a
 * substantive error, so the chain never stepped past the cheapest-capable pick
 * and auto mode blocked every call of the session (findings §10.19). It is
 * anchored to the word "model" ahead of it, because plenty of REQUEST-shape
 * complaints are phrased the same way ("streaming is not supported",
 * "response_format is not supported for this model") and those are fixable
 * quirks of one call, not a model this account can never use.
 */
export function isModelUnavailableError(message: string): boolean {
	return /\b(401|403|404)\b|not_found|not found|does not exist|(no|have|lacks?)\s+access|unauthoriz|forbidden|invalid[_ -]?model|model[_ -]?not|unsupported[_ -]?model|\bmodel\b[^.\n]{0,40}not supported|no such model|entitl|insufficient[_ -]?quota|exceeded your current quota|billing/i.test(
		message,
	);
}

/** One-line description for the notice and `/auto-mode config`. */
export function describeCandidate(candidate: Candidate): string {
	const name = spec(candidate.model);
	const where = modelIdentity(candidate.model).profile ?? candidate.model.provider;
	switch (candidate.source) {
		case "configured":
			return `${name} (autoMode.classifierModel)`;
		case "economical":
			return `${name} (cheapest model within ${where} in the session's tier or above that contains the session catalog context window)`;
		case "session":
			return `${name} (this session's model)`;
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

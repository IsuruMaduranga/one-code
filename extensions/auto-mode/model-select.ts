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
 * if that cannot be proved, it screens on the session model instead.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { capabilityFloor, scoreFor } from "../lib/capability-index.ts";
import { modelIdentity, modelSpec as spec, pricedInput } from "../lib/model-policy.ts";
import { atLeastTier, automaticTierFloor, currentCapabilitySnapshot, economicalContainedCandidates, intrinsicTier } from "../lib/model-tier.ts";

export interface Candidate {
	model: Model<Api>;
	/** How this candidate was arrived at, for the notice shown to the user. */
	source: "economical" | "session";
}

export interface SelectInput {
	/** Models the user actually has working credentials for. */
	available: Model<Api>[];
	sessionModel: Model<Api> | undefined;
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
}

/**
 * The ordered fallback chain for the permission classifier. Automatic entries
 * stay on the session provider/route, pass the capability floor, and have a
 * known catalog window at least as large as the session's. Below frontier,
 * an alternate must be measured and in the session's tier (or measured at
 * least as capable); only frontier sessions may use unscored alternates by tier. Numeric input cost orders the qualifying models, with
 * the session retained as an availability fallback.
 */
export function classifierCandidates({
	available,
	sessionModel,
}: SelectInput): { candidates: Candidate[]; notices: ClassifierNotice[]; fallback?: ClassifierFallback } {
	const candidates: Candidate[] = [];
	const notices: ClassifierNotice[] = [];
	const push = (model: Model<Api> | undefined, source: Candidate["source"]) => {
		if (!model) return;
		if (candidates.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id)) return;
		candidates.push({ model, source });
	};

	// A classifier gets the whole user transcript. It must stay on the session's
	// provider/route, meet the existing capability floor, and be able to receive
	// every token the session catalog says the main model can receive. Catalog
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

	const frontierSession = atLeastTier(intrinsicTier(sessionModel), "frontier");
	const floor = automaticTierFloor(sessionModel);
	const snapshot = currentCapabilitySnapshot();
	const sessionTier = intrinsicTier(sessionModel);
	/** Whether the capability snapshot holds a confirmed score for `model` (thinking off or default effort). */
	const measuredAtAll = (model: Model<Api>) =>
		!!snapshot && (scoreFor(snapshot, model, "non-reasoning") !== undefined || scoreFor(snapshot, model, "default") !== undefined);
	const capable = (model: Model<Api>) => {
		const measured = capabilityFloor(snapshot, model, sessionModel, "classifier").verdict;
		if (measured === "pass") return true;
		if (frontierSession) return measured === "unscored" && atLeastTier(intrinsicTier(model), floor);
		// Below frontier: the session itself, or an alternate that is measured
		// and in the session's own tier (its score need not reach the
		// session's). A name-based tier alone is not evidence.
		const isSession = model.provider === sessionModel.provider && model.id === sessionModel.id;
		return isSession || (measuredAtAll(model) && intrinsicTier(model) === sessionTier);
	};
	const belowFrontierFallbackText = `Auto mode is screening calls with ${spec(sessionModel)}, this session's model, because no cheaper same-provider/route model is measured and in this session's tier while containing its ${sessionModel.contextWindow}-token catalog context window.`;
	// `economicalContainedCandidates` supplies the existing containment, variant,
	// generation, tool-capability, price-known and never-tiny gates. Its own
	// cheap/workhorse/frontier ordering is deliberately replaced below: this policy
	// selects the numerically cheapest model that clears those gates.
	const eligible = economicalContainedCandidates(available, sessionModel)
		.filter(capable)
		.filter((model) => hasCatalogContextWindow(model) && model.contextWindow >= sessionModel.contextWindow);
	// A catalog normally includes the active model, but the active row is also a
	// valid choice when it is absent from a stale catalog. Include it only when it
	// meets the same automatic gates; a tiny session remains a terminal fallback.
	if (
		intrinsicTier(sessionModel) !== "tiny" &&
		pricedInput(sessionModel) !== undefined &&
		capable(sessionModel) &&
		!eligible.some((model) => model.provider === sessionModel.provider && model.id === sessionModel.id)
	) eligible.push(sessionModel);
	eligible.sort((a, b) => pricedInput(a)! - pricedInput(b)!);
	for (const model of eligible) {
		push(model, model.provider === sessionModel.provider && model.id === sessionModel.id ? "session" : "economical");
	}
	if (candidates.length > 0) {
		// The startup notice needs a reason even when the session was eligible in
		// its own right: otherwise a renderer cannot distinguish "no alternate can
		// contain the transcript" from "the session is simply the cheapest choice".
		if (candidates[0].source === "session") {
			const hasAlternate = candidates.some((candidate) => candidate.source === "economical");
			const fallback: ClassifierFallback = hasAlternate
				? {
					reason: "session-is-cheapest-qualified",
					text: frontierSession
						? `Auto mode is screening calls with ${spec(sessionModel)}, this session's model, because it is the cheapest same-provider/route model meeting the capability floor and this session's ${sessionModel.contextWindow}-token catalog context window.`
						: belowFrontierFallbackText,
				}
				: {
					reason: "no-qualifying-model",
					text: frontierSession
						? `Auto mode is screening calls with ${spec(sessionModel)}, this session's model, because no other same-provider/route model meets both the capability floor and this session's ${sessionModel.contextWindow}-token catalog context window.`
						: belowFrontierFallbackText,
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

	const fallback: ClassifierFallback = {
		reason: "no-qualifying-model",
		text: frontierSession
			? `Auto mode is screening calls with ${spec(sessionModel)}, this session's model, because no same-provider/route model meets both the capability floor and this session's ${sessionModel.contextWindow}-token catalog context window.`
			: belowFrontierFallbackText,
	};
	push(sessionModel, "session");
	notices.push({ level: "info", text: fallback.text, fallbackReason: fallback.reason });
	return { candidates, notices, fallback };
}

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
		case "economical":
			return `${name} (cheapest model within ${where} that meets the capability floor (below frontier: measured and in the session's tier) and contains the session catalog context window)`;
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

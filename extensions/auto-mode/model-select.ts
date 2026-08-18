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
	crossesProvider,
	findConfigured,
	isStaleContainmentStamp,
	modelIdentity,
	modelSpec as spec,
} from "../lib/model-policy.ts";
import { cheaperContainedCandidates } from "../lib/model-tier.ts";

export { findConfigured } from "../lib/model-policy.ts";

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
	 * The containment identity (`modelIdentity().containment`) the `classifierModel`
	 * setting was stamped for when set via `/auto-mode model`. When it differs from
	 * the current session's containment, a cross-provider setting is treated as
	 * stale (set for a session since left) and overridden with a warning — the same
	 * shape as the subagent `subagentModelSetFor` stamp. Undefined for a hand-edited
	 * setting.
	 */
	configuredSetForContainment?: string;
}

/** A user-facing selection notice, tagged so an informational one is not shown as a warning. */
export interface ClassifierNotice {
	level: "info" | "warning";
	text: string;
}

/**
 * The ordered candidate chain plus any user-facing notices. More than one
 * candidate is returned so one that turns out to be unusable at call time (not
 * entitled on this account, withdrawn by the provider) can be stepped over
 * instead of failing every tool call — the same shape as pi's subagent
 * `fallbackModels`.
 *
 * The chain always ends at the session model when there is one, so auto mode
 * degrades to "correct but not cheap" rather than to "broken".
 *
 * The automatic pick is the SAME tier selector subagents use — the cheapest
 * *capable* same-provider model (cheap → workhorse → frontier, never `tiny`),
 * so a session screens and delegates on one economical model. That closes the
 * capability floor `docs/decisions/auto-mode.md` recorded as still-missing: a
 * sub-Haiku model is a weak security boundary, so automatic selection never
 * lands there.
 */
export function classifierCandidates({
	available,
	sessionModel,
	configured,
	configuredSetForContainment,
}: SelectInput): { candidates: Candidate[]; notices: ClassifierNotice[] } {
	const candidates: Candidate[] = [];
	const notices: ClassifierNotice[] = [];
	const push = (model: Model<Api> | undefined, source: Candidate["source"]) => {
		if (!model) return;
		if (candidates.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id)) return;
		candidates.push({ model, source });
	};

	// 1. What the user asked for. Naming a provider is choosing it — but a setting
	//    stamped for a provider this session has since left is stale and overridden
	//    with a warning (parity with the subagent setting); a genuine cross-provider
	//    choice made for THIS session is honored with an announcement, because the
	//    classifier reads the user's prompts and CLAUDE.md.
	const resolved = configured ? findConfigured(available, configured) : undefined;
	if (resolved) {
		if (sessionModel && crossesProvider(resolved, sessionModel)) {
			if (isStaleContainmentStamp(configuredSetForContainment, sessionModel)) {
				notices.push({
					level: "warning",
					text:
						`autoMode.classifierModel ${spec(resolved)} was set for a different provider than this session (${spec(sessionModel)}); ` +
						"a same-provider model screens calls instead. Re-set it with /auto-mode model on this session to use it here.",
				});
			} else {
				// Informational, not a warning: the user deliberately set this for this
				// session, so it is doing exactly what they asked.
				notices.push({
					level: "info",
					text:
						`autoMode.classifierModel ${spec(resolved)} is a different provider than this session (${spec(sessionModel)}) — ` +
						"it reads your prompts and CLAUDE.md, so those go to that provider. It was set for this session, so it is honored.",
				});
				push(resolved, "configured");
			}
		} else {
			push(resolved, "configured");
		}
	}

	// 2. The cheapest capable same-provider model, no dearer than the work being
	//    screened — screening a call more expensively than making it is
	//    indefensible. The shared gate excludes `tiny`, unpriced/opaque rows, and
	//    the session model itself, so an unpriced provider yields nothing here and
	//    the session model (step 3) screens the calls.
	if (sessionModel) {
		for (const model of cheaperContainedCandidates(available, sessionModel)) push(model, "economical");
	}

	// 3. The session's own model: always correct, just not cheap. Terminal fallback,
	//    so the gate degrades to screening on it rather than to broken.
	push(sessionModel, "session");

	// Nothing configured and no session model (a headless run with a bare
	// registry) — take anything available rather than refusing outright.
	if (candidates.length === 0) push(available[0], "session");

	// A configured spec that matched nothing available would otherwise fall through
	// in silence, leaving the user believing their setting is in force.
	if (configured && !resolved) {
		const instead = candidates[0];
		notices.push({
			level: "warning",
			text:
				`autoMode.classifierModel is set to "${configured}", which is not an available model — check the name and that its provider is authenticated.` +
				(instead ? ` Auto mode is using ${describeCandidate(instead)} instead.` : ""),
		});
	}

	return { candidates, notices };
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
	const name = spec(candidate.model);
	const where = modelIdentity(candidate.model).profile ?? candidate.model.provider;
	switch (candidate.source) {
		case "configured":
			return `${name} (from autoMode.classifierModel)`;
		case "economical":
			return `${name} (cheapest capable model within ${where})`;
		case "session":
			return `${name} (this session's model — no cheaper capable model within ${where})`;
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

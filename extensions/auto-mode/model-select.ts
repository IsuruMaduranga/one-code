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
import { atLeastTier, cheaperContainedCandidates, intrinsicTier, type PromptTier } from "../lib/model-tier.ts";

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
 * *capable* same-provider model (cheap → workhorse → frontier, never `tiny`) —
 * with one floor of its own ({@link classifierTierFloor}): a session on a
 * workhorse-or-better model is screened by a workhorse-or-better model, Claude
 * Code's `min(main, sonnet)`. `docs/decisions/auto-mode.md` measured the same
 * `rm -rf` grading stage-1 62 on Sonnet and ~22 on Haiku — "a weak classifier
 * is a weak boundary" — yet until 2026-09-05 the selector picked Haiku even
 * when the session itself was Sonnet, so the gate's threshold behaviour
 * depended on which model happened to be cheapest (PERMISSIONS-REVIEW-2026-09-05
 * M6). A cheap session keeps a cheap screener (nothing cheaper and capable
 * exists), and `autoMode.classifierModel` overrides either way. The `tiny`
 * exclusion is the capability floor `auto-mode.md` recorded as still-missing.
 *
 * The floor governs the AUTOMATIC pick only; the terminal fallback is never
 * refused, so the chain is empty only when there is no session model and nothing
 * available at all.
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
		const floor = classifierTierFloor(sessionModel);
		for (const model of cheaperContainedCandidates(available, sessionModel)) {
			if (atLeastTier(intrinsicTier(model), floor)) push(model, "economical");
		}
	}

	// 3. The session's own model: always correct, just not cheap. Terminal
	//    fallback, so the gate degrades to screening on it rather than to broken.
	//    No tier floor here: a floor that refused a `tiny` session model would
	//    disarm auto mode on exactly the sessions least able to do without it,
	//    on a price-and-name heuristic rather than measured competence. The
	//    circumvention of a permission rule that motivated one is handled by
	//    giving the classifier the user's own deny rules to judge by effect
	//    (permissions/rule-prose.ts), not by picking a different screener.
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
 * The weakest tier the automatic classifier may run on for a session: workhorse
 * when the session itself is workhorse or frontier (Claude Code's
 * `min(main, sonnet)`), cheap otherwise (a cheap session has nothing cheaper
 * and capable to screen it; `tiny` is excluded upstream regardless).
 */
export function classifierTierFloor(sessionModel: Model<Api>): PromptTier {
	const tier = intrinsicTier(sessionModel);
	return tier === "frontier" || tier === "workhorse" ? "workhorse" : "cheap";
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
			return `${name} (from autoMode.classifierModel)`;
		case "economical":
			return `${name} (cheapest model within ${where} no weaker than the session's tier floor)`;
		case "session":
			return `${name} (this session's model — nothing cheaper within ${where} meets the tier floor)`;
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

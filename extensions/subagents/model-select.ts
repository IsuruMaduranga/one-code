/**
 * Choosing a subagent's model (pure).
 *
 * ## Why this exists
 *
 * The `model` field used to be passed as a raw string to the child's
 * `pi --model`, whose fuzzy matcher substring-matches across **every configured
 * provider**, preferring alias ids and then reverse-lexicographic order. With
 * two providers authenticated, `model: "sonnet"` — which is what real
 * `.claude/agents` files and `CLAUDE_CODE_SUBAGENT_MODEL` say — resolved to an
 * effectively arbitrary provider. A fork child inherits the parent's entire
 * transcript, so a silently cross-provider subagent is the same privacy bug the
 * classifier's model selection fixed, with higher stakes.
 *
 * So resolution happens in the *parent*, against the real registry, and the
 * child is spawned with a concrete `provider/id`:
 *
 * - Claude Code aliases (`sonnet`/`opus`/`haiku`/`fable`) resolve **within the
 *   session's provider** (and contained route/model family on gateways): by
 *   name where a model carries it, else as the Claude Code *tier* the alias
 *   names — `haiku` the cheapest capable contained model, `sonnet` the cheapest
 *   workhorse-class one, `opus`/`fable` the session model — and the parent says
 *   so (2026-09-11; before, an off-family alias landed on the session model,
 *   the most expensive answer available, and a global "use Sonnet for
 *   subagents" instruction did exactly that on every non-Anthropic provider).
 * - An exact per-call reference (the main model's `model` field) or the user's
 *   own `subagentModel` setting resolves anywhere — naming a model is choosing
 *   it — but crossing providers is announced, never silent.
 * - An `.claude/agents` model field is a Claude Code convention: honored on a
 *   Claude-family session, but on any other provider a cross-provider one is
 *   *not* honored (a fork inherits the parent transcript, so subagents stay on
 *   the session's provider) — the configured default or the automatic
 *   same-provider profile serves instead.
 * - A configured default or agent-file model that cannot resolve degrades, with
 *   a notice naming the knob, to the automatic same-provider pick — the
 *   cheapest contained model at the session's capability floor, the SAME floor
 *   the auto-mode classifier applies (`capableContainedCandidates`) — and only
 *   then to the session model. Only an explicit `inherit` names the session
 *   model outright. A bad *per-call* request first falls through to the agent's
 *   own model and the configured default (running the subagent on its intended
 *   model, with a notice); only when nothing downstream resolves does it error,
 *   so the model can read the menu and retry.
 *
 * The menu keeps the main model informed without dumping a 300-model gateway
 * catalog into every request: vendor-contained, variant- and unpriced-filtered,
 * dated duplicates collapsed, capped — and explicitly *not* a whitelist, since
 * resolution accepts any available model whether or not it was listed.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { SubagentDefault } from "./default-model.ts";
import {
	crossesProvider,
	findConfigured,
	isClaudeFamilyModel,
	isDatedDuplicate,
	isSnapshotDatedId,
	isStaleContainmentStamp,
	modelsContainedToSession,
	modelSpec as spec,
	pricedInput,
	supportsImageInput,
} from "../lib/model-policy.ts";
import { atLeastTier, capableContainedCandidates, economicalContainedCandidates, intrinsicTier, type PromptTier } from "../lib/model-tier.ts";

/**
 * Cross-extension channel carrying the resolved default subagent model, so the
 * banner can show it when it differs from the session model (jiti isolates
 * module state, so this goes over `pi.events`).
 */
export const SUBAGENT_STATUS_CHANNEL = "one-code:subagent-status";

export interface SubagentStatus {
	/** `provider/id` subagents will run on. Unset only when nothing resolves at all. */
	model?: string;
	/** Where that came from: a setting, automatic role profile, or the session. */
	via?: "setting" | "env" | "auto" | "session";
}

/**
 * What the banner's `subagents` slot shows: the model subagents will actually
 * run on, always, tagged with how it was selected — a user who just ran `/subagent`
 * must see their choice land, and after `/subagent clear` the slot going blank
 * read as breakage rather than "back to the session model". The tag comes from
 * the *resolution*, not the configuration: a configured default that degraded
 * (off-family alias, unavailable model) honestly reads "session".
 */
export function subagentStatusModel(
	configured: { source: "subagentModel setting" | "CLAUDE_CODE_SUBAGENT_MODEL" } | undefined,
	resolution: Pick<SubagentModelResolution, "model" | "source">,
): SubagentStatus {
	if (!resolution.model) return {};
	const via =
		resolution.source === "default" && configured
			? configured.source === "subagentModel setting"
				? "setting"
				: "env"
			: resolution.source === "automatic"
				? "auto"
				: "session";
	return { model: spec(resolution.model), via };
}

/**
 * Claude Code's Agent-tool aliases, read as the tiers they name: `haiku` the
 * cheap line, `sonnet` the workhorse line, `opus`/`fable` the frontier. An alias
 * resolves by NAME within the session's provider family when a model carries it
 * (an Anthropic session), else as its tier there — see `resolveAlias`.
 */
const ALIAS_TIER: Record<string, PromptTier> = { haiku: "cheap", sonnet: "workhorse", opus: "frontier", fable: "frontier" };

export type SubagentModelSource = "call" | "agent" | "default" | "automatic" | "session";

export interface ResolveInput {
	/** Per-call `model` param — chosen by the main model. */
	requested?: string;
	/** The agent definition's frontmatter `model`. */
	agentModel?: string;
	/**
	 * The `subagentModel` setting / `CLAUDE_CODE_SUBAGENT_MODEL`, with its knob
	 * (`source`) and, for the setting, the session provider it was stamped for
	 * (`setForProvider`). A cross-provider setting stamped for a provider since
	 * left — or unstamped (hand-edited) — is stale and skipped so a same-provider
	 * model runs; see the resolve loop.
	 */
	configuredDefault?: SubagentDefault;
	sessionModel?: Model<Api>;
	available: Model<Api>[];
	/**
	 * Set by a spawn path when the session model is image-capable: the subagent
	 * inherits the parent transcript (fork) or may read an image/PDF file by path
	 * (any run), so a text-only worker cannot serve. The automatic pick and any
	 * alias then resolve to an image-capable same-provider model; an explicit
	 * text-only choice is hard-blocked (a per-call `model` field, retryable) or
	 * upgraded with a notice (a standing setting or agent-file model). The
	 * `/subagent` set command leaves this false — a saved default may be meant for
	 * another (text) session, and is gated at spawn instead. See
	 * `working-docs/decisions/model-policy.md`.
	 */
	requireImageInput?: boolean;
}

export interface SubagentModelResolution {
	/** The model to spawn with. Undefined only when nothing at all is available. */
	model?: Model<Api>;
	source: SubagentModelSource;
	/**
	 * Set when a *per-call* request resolves to nothing: the caller should fail
	 * the tool call with the menu, so the model that chose the string can retry.
	 */
	unresolved?: string;
	/**
	 * The reason for `unresolved`, when it is not the plain "no such model" case —
	 * currently only a per-call text-only model refused on an image-capable
	 * session. The caller shows this in place of its default "unknown model" line
	 * so the fix is named. Undefined for an ordinary unavailable model.
	 */
	unresolvedReason?: string;
	/** One-line warnings the parent should surface (fallbacks, provider crossings). */
	notices: string[];
}

/**
 * The model-facing form of a resolution's notices, for the spawn tool's result.
 *
 * Every notice above says what was NOT honored ("falling back to the agent's
 * configured model or the session default"); none of them names where the walk
 * actually landed, because it is written before the chain finishes. The user
 * can see the answer in the banner, but the model that asked for `sonnet` could
 * not: on a non-Anthropic session — where a global "use Sonnet for subagents"
 * memory shared with Claude Code makes that the standing request — it spawned
 * children believing they ran on Sonnet and reasoned about their cost and
 * capability on that basis (WEAK-MODEL-REVIEW-2026-09-06 L4).
 *
 * So the concrete spec is appended whenever there is a notice at all. It is
 * stated rather than inferred even when a notice already mentions that spec:
 * the notices name models in every position — the session ("no sonnet model in
 * this session's provider family (openai/gpt-5.1)"), the one refused, the one
 * honored — and a reader cannot tell which mention is the answer.
 *
 * The source rides along because it is the question the answer raises. The
 * notices used to end by listing which knob might serve next; naming the one
 * that actually did is the same information after the fact, and true.
 */
const SOURCE_LABEL: Record<SubagentModelSource, string> = {
	call: "the model this call named",
	agent: "the agent's own model",
	default: "the configured default",
	automatic: "the automatic smaller default",
	session: "this session's model",
};

export function subagentModelNotes(resolution: Pick<SubagentModelResolution, "model" | "notices" | "source">): string[] {
	if (resolution.notices.length === 0) return [];
	if (!resolution.model) return [...resolution.notices];
	return [...resolution.notices, `This subagent runs on ${spec(resolution.model)} (${SOURCE_LABEL[resolution.source]}).`];
}

interface AliasResolution {
	model: Model<Api>;
	/** "name": a contained model carries the alias; "tier": the alias's Claude Code tier, resolved here. */
	how: "name" | "tier";
}

/**
 * Resolve a Claude Code alias within the session's provider family: by name
 * first (preferring undated alias ids, then the newest id), else as the tier
 * the alias names — the cheapest contained model at or above it
 * (`economicalContainedCandidates` order: never tiny, prior-generation or
 * tool-less; cheap → workhorse → frontier, then price), `frontier` meaning the
 * session model itself, the strongest model the user chose on this provider.
 * Never off-family: "sonnet" on a Codex session is the cheapest workhorse-class
 * Codex model, not Anthropic's Sonnet. The aliases ARE Claude Code's tier
 * names, so the tier reading honors what the alias meant rather than
 * substituting a model nobody described. Undefined only when the provider has
 * nothing capable to offer (unpriced/opaque) or there is no session model.
 */
function resolveAlias(
	alias: string,
	contained: Model<Api>[],
	available: Model<Api>[],
	sessionModel: Model<Api> | undefined,
	requireImageInput = false,
): AliasResolution | undefined {
	// An alias asks for a *class*, so an image-capable session resolves it to an
	// image-capable model of that class rather than erroring — the alias is
	// auto-upgraded, never hard-blocked (unlike an explicit text-only id).
	const imageOk = (model: Model<Api>) => !requireImageInput || supportsImageInput(model);
	const matches = contained.filter((model) => model.id.toLowerCase().includes(alias) && imageOk(model));
	if (matches.length > 0) {
		const undated = matches.filter((model) => !isSnapshotDatedId(model.id));
		const pool = undated.length > 0 ? undated : matches;
		return { model: pool.sort((a, b) => b.id.localeCompare(a.id))[0], how: "name" };
	}
	if (!sessionModel) return undefined;
	const tier = ALIAS_TIER[alias];
	// The session model carries the caller's own modality, so frontier is always safe.
	if (tier === "frontier") return { model: sessionModel, how: "tier" };
	// Name-class only, deliberately: an explicit alias asks for a *class* of model,
	// so a measured pass (which lets a strong flash serve the automatic default)
	// does not lift a lean-named model into "sonnet" here.
	const byTier = economicalContainedCandidates(available, sessionModel, contained, requireImageInput).find((model) => atLeastTier(intrinsicTier(model), tier));
	return byTier ? { model: byTier, how: "tier" } : undefined;
}

export function resolveSubagentModel(input: ResolveInput): SubagentModelResolution {
	const { available, sessionModel } = input;
	const notices: string[] = [];

	const chain: { value: string; source: SubagentModelSource; knob: string }[] = [];
	if (input.requested) chain.push({ value: input.requested, source: "call", knob: "the model field" });
	if (input.agentModel) chain.push({ value: input.agentModel, source: "agent", knob: "the agent file's model" });
	if (input.configuredDefault) {
		chain.push({ value: input.configuredDefault.spec, source: "default", knob: "the configured subagent default" });
	}

	const contained = sessionModel ? modelsContainedToSession(available, sessionModel) : [];
	let suppressAutomatic = false;
	// A per-call `model` that did not resolve — deferred, not errored (see the
	// "per-call request" paragraph in the module doc above).
	let callFailed: string | undefined;
	let callFailedReason: string | undefined;

	// The modality gate: when the caller marks the session image-capable, a
	// text-only worker cannot receive the images/PDFs the session may feed it. An
	// EXPLICIT text-only id is refused here (a per-call `model` field is
	// hard-blocked so the model retries; a standing setting or agent-file model is
	// upgraded with a notice). Aliases and the automatic pick are steered to an
	// image-capable model upstream instead, never refused. `requireImageInput`
	// already reflects `supportsImageInput(sessionModel)` — the caller computed it.
	const requireImageInput = input.requireImageInput ?? false;
	const modalityMismatch = (model: Model<Api>) => requireImageInput && !supportsImageInput(model);

	// The `subagentModel` setting is stale when it was stamped for a different
	// provider than this session (or never stamped — a hand-edited setting): the
	// user switched the session's provider since setting it, so a cross-provider
	// value is not honored and a same-provider model runs instead. A deliberate
	// choice made on this provider (stamp matches) is still honored + announced.
	const settingIsStale =
		input.configuredDefault?.source === "subagentModel setting" &&
		isStaleContainmentStamp(input.configuredDefault.setForContainment, sessionModel);

	for (const entry of chain) {
		const wanted = entry.value.trim();
		if (!wanted || wanted.toLowerCase() === "inherit") {
			suppressAutomatic = true; // explicit "use the session model"
			break;
		}

		const alias = wanted.toLowerCase();
		if (alias in ALIAS_TIER) {
			const resolved = resolveAlias(alias, contained, available, sessionModel, requireImageInput);
			if (resolved?.how === "name") return { model: resolved.model, source: entry.source, notices };
			// SCOPE the claim. "No sonnet model exists" is false at machine level
			// whenever Anthropic is also authenticated, and a model relaying it tells
			// the user "Sonnet is not available" — wrong, and the everyday case given
			// a global "use Sonnet for subagents" memory on another provider. What is
			// true is narrower: the alias cannot leave this session's containment.
			// "Provider family" covers both a plain provider and a gateway, where
			// containment is the model-creator namespace (`modelsContainedToSession`).
			const family = sessionModel ? ` (${spec(sessionModel)})` : "";
			if (resolved) {
				// The tier reading: what the alias meant, on this provider. Stated so
				// the model that asked for "sonnet" knows which model actually runs
				// (WEAK-MODEL-REVIEW-2026-09-06 L4) — `subagentModelNotes` repeats the
				// spec, but this line says WHY it is not Sonnet.
				notices.push(`No "${alias}" model in this session's provider family${family}; read as its Claude Code tier, "${alias}" resolves to ${spec(resolved.model)} here.`);
				return { model: resolved.model, source: entry.source, notices };
			}
			// Nothing capable contained at all (an unpriced/opaque provider, or no
			// session model): keep walking the chain — the agent's model / configured
			// default may still resolve — then the automatic pick or the session
			// model serve below. Never `unresolved`: unlike a literal typo, an
			// off-family alias is a naming mismatch, not a retryable mistake.
			notices.push(`No "${alias}" model in this session's provider family${family}.`);
			continue;
		}

		const resolved = findConfigured(available, wanted);
		if (resolved) {
			if (modalityMismatch(resolved)) {
				// An explicit text-only id on an image-capable session. A per-call
				// `model` field is hard-blocked (deferred like an unavailable model,
				// so the chain may still land on the agent/default, else the caller
				// shows the menu and the model retries with an image-capable one). A
				// standing setting or agent-file model is upgraded silently to the
				// automatic same-provider image-capable pick with a notice, because
				// the user configured it once and it should not break a fork.
				if (entry.source === "call") {
					callFailed = wanted;
					callFailedReason =
						`Requested subagent model ${spec(resolved)} is text-only, but this session works with images or PDFs a subagent may need to read ` +
						"(the inherited transcript, or a file it opens). Pick an image-capable model.";
					notices.push(callFailedReason);
				} else {
					notices.push(
						`${spec(resolved)} (from ${entry.knob}) is text-only, but this session works with images or PDFs a subagent may need to read; ` +
							"an image-capable same-provider model runs this subagent instead.",
					);
				}
				continue;
			}
			if (sessionModel && crossesProvider(resolved, sessionModel)) {
				// An `.claude/agents` model is a Claude Code convention; on a
				// non-Claude session it does not get to move a subagent (which
				// inherits the parent transcript) onto another provider. Skip it and
				// let the configured default or the automatic same-provider profile
				// serve. Per-call `model` and the user's own `subagentModel` setting
				// are explicit choices, so their crossings are still honored + announced.
				if (entry.source === "agent" && !isClaudeFamilyModel(sessionModel)) {
					notices.push(
						`The agent file's model ${spec(resolved)} is a different provider than this session (${spec(sessionModel)}); ` +
							"on a non-Claude session subagents stay on this provider, so a same-provider model runs this subagent instead.",
					);
					continue;
				}
				if (entry.source === "default" && settingIsStale) {
					notices.push(
						`The configured subagent default ${spec(resolved)} was set for a different provider than this session (${spec(sessionModel)}); ` +
							"a same-provider model runs this subagent instead. Re-set it with /subagent on this session to use it here.",
					);
					continue;
				}
				notices.push(
					`Subagent model ${spec(resolved)} is a different provider/family than this session (${spec(sessionModel)}) — it was named via ${entry.knob}, so it is honored.`,
				);
			}
			return { model: resolved, source: entry.source, notices };
		}

		if (entry.source === "call") {
			// Defer to the rest of the chain (see the module doc): record the
			// failure and keep walking, erroring after the loop only if nothing
			// downstream resolves.
			callFailed = wanted;
			notices.push(
				`Requested subagent model "${wanted}" is not available — falling back to the agent's configured model or the session default.`,
			);
			continue;
		}
		// An explicit choice failed: the rest of the chain, then the automatic
		// same-provider pick, then the session model serve. The automatic pick is
		// no more "a model nobody described" than the session model is, and it is
		// the cheaper of the two (2026-09-11; before, this dropped straight to the
		// session model).
		notices.push(
			entry.source === "agent"
				? `Subagent model "${wanted}" (from ${entry.knob}) is not available — falling back to the configured default, the automatic same-provider pick, or the session model.`
				: `Subagent model "${wanted}" (from ${entry.knob}) is not available — the automatic same-provider pick or the session model runs this subagent instead.`,
		);
	}

	// Per-call model failed and nothing downstream resolved: surface it so the
	// caller shows the menu and the model retries, rather than silently dropping
	// to the automatic/session pick for a model the main model named.
	if (callFailed) return { source: "call", unresolved: callFailed, unresolvedReason: callFailedReason, notices };

	// Automatic selection is a cost optimisation, so it needs price evidence:
	// with the session price unknown there is no demonstrable saving, and picking
	// a cheap-tier model could silently *upgrade* an (unpriced) cheap session. The
	// floor-gated selector — the cheapest same-provider model at the session's
	// capability floor (workhorse-or-better for a workhorse-or-better session,
	// Claude Code's min(main, sonnet); never `tiny`) — is the SAME one the
	// auto-mode classifier uses, so a session screens and delegates on one
	// model. A delegated worker writes code and calls tools for many turns; a
	// weaker one spends the saving on retries (2026-09-11 — before, subagents
	// took the cheapest capable model with no floor). It excludes unpriced/opaque
	// providers by construction, which subsumes the old dynamic-selection gate;
	// those degrade to the session model below.
	if (sessionModel && !suppressAutomatic) {
		// `strict` requires a genuinely cheaper model and yields nothing when the
		// session price is unknown, so a cheap-tier pick never silently upgrades an
		// unpriced session. Reuse the `contained` set computed above for the hot path.
		// With an Artificial Analysis snapshot (lib/capability-index.ts) the floor
		// is measured — coding index ≥ min(session, Sonnet 5), no tolerance —
		// and passers rank by price; unscored candidates are judged by name-class tier.
		const cheaper = capableContainedCandidates(available, sessionModel, "subagent", { strict: true, contained, requireImageInput })[0];
		if (cheaper) return { model: cheaper, source: "automatic", notices };
	}

	if (sessionModel) return { model: sessionModel, source: "session", notices };
	return { model: available[0], source: "session", notices };
}

/**
 * The per-call expensive-model gate. Only a `source: "call"` resolution is ever
 * gated: the per-call `model` field is the one input the main model chooses for
 * itself. User knobs (setting, env var, agent files the user installed,
 * "inherit") are never gated — naming a model is choosing it — and the
 * automatic default can only ever pick cheaper. With either price unknown the
 * gate stays open: a gate that fails closed on an unpriced catalog blocks the
 * feature outright.
 *
 * Returns the factual comparison; the caller appends its own override hint
 * (the subagent tool and workflow agent() spell the field differently).
 */
export function expensiveModelGate(
	resolution: Pick<SubagentModelResolution, "model" | "source">,
	sessionModel: Model<Api> | undefined,
	allowExpensive: boolean | undefined,
): string | undefined {
	if (allowExpensive) return undefined;
	if (resolution.source !== "call" || !resolution.model || !sessionModel) return undefined;
	const sessionPrice = pricedInput(sessionModel);
	const requestedPrice = pricedInput(resolution.model);
	if (sessionPrice === undefined || requestedPrice === undefined || requestedPrice <= sessionPrice) return undefined;
	return (
		`Requested model ${spec(resolution.model)}${price(resolution.model)} costs more per input token ` +
		`than this session's model ${spec(sessionModel)}${price(sessionModel)}.`
	);
}

export interface MenuOptions {
	available: Model<Api>[];
	sessionModel?: Model<Api>;
	/** The resolved default (configured, automatic, or session fallback). */
	defaultModel?: Model<Api>;
	defaultSource?: SubagentModelSource;
	/** How many cheaper-option lines to include. */
	maxCheaper?: number;
	/**
	 * When true (an image-capable session), text-only models are omitted from the
	 * menu — they would only be rejected again on retry (`modalityMismatch`). The
	 * caller passes `supportsImageInput(sessionModel)`.
	 */
	requireImageInput?: boolean;
	/**
	 * The configured default and which knob set it, so the reminder can tell the
	 * main model when the user has *manually* pinned the subagent model via the
	 * `subagentModel` setting (as opposed to Claude Code's env var or automatic
	 * selection). Only the setting triggers the notice.
	 */
	configured?: SubagentDefault;
}

const price = (model: Model<Api>): string => {
	const input = pricedInput(model);
	return input === undefined ? "" : ` ($${input}/M in)`;
};

/**
 * The curated menu: never the catalog. Vendor-contained, variants and unpriced
 * entries dropped, dated duplicates collapsed, capped — useful, not complete,
 * which is safe because resolution accepts unlisted models too.
 */
export function subagentModelMenu({ available, sessionModel, defaultModel, defaultSource, maxCheaper = 3, requireImageInput = false }: MenuOptions): string[] {
	const lines: string[] = [];
	const listed = new Set<string>();
	// On an image-capable session a text-only model is rejected on retry
	// (`modalityMismatch`), so it never belongs in a retry menu.
	const imageOk = (model: Model<Api>) => !requireImageInput || supportsImageInput(model);
	const add = (model: Model<Api>, label: string) => {
		if (listed.has(spec(model)) || !imageOk(model)) return;
		listed.add(spec(model));
		lines.push(`- ${spec(model)}${price(model)} — ${label}`);
	};

	if (defaultModel) {
		const label =
			defaultSource === "automatic"
				? "the automatic smaller default"
				: sessionModel && spec(defaultModel) === spec(sessionModel)
					? "the default (this session's model)"
					: "the configured default";
		add(defaultModel, label);
	}
	if (sessionModel) add(sessionModel, "this session's model");

	if (sessionModel) {
		const contained = modelsContainedToSession(available, sessionModel).filter((model) => !listed.has(spec(model)));
		const priced = contained
			.map((model) => ({ model, input: pricedInput(model) }))
			.filter((entry): entry is { model: Model<Api>; input: number } => entry.input !== undefined)
			// Collapse dated duplicates when the undated alias is also present.
			.filter((entry) => !isDatedDuplicate(entry.model, contained))
			.sort((a, b) => a.input - b.input);
		const sessionPrice = pricedInput(sessionModel);
		for (const entry of priced) {
			if (lines.length >= (defaultModel ? 2 : 1) + maxCheaper) break;
			if (sessionPrice !== undefined && entry.input >= sessionPrice) break;
			add(entry.model, "cheaper, same provider");
		}
	}

	return lines;
}

/**
 * One informational line when the default subagent model costs more per input
 * token than the session model itself. Automatic selection can never pick a
 * pricier model, so this only ever describes a *configured* default — which can
 * be deliberate (cheap driver, strong workers), so the line informs the main
 * model rather than instructing it to override the user's knob.
 */
export function defaultCostsMoreWarning({ sessionModel, defaultModel }: MenuOptions): string | undefined {
	if (!sessionModel || !defaultModel) return undefined;
	const sessionPrice = pricedInput(sessionModel);
	const defaultPrice = pricedInput(defaultModel);
	if (sessionPrice === undefined || defaultPrice === undefined || defaultPrice <= sessionPrice) return undefined;
	return (
		`Note: the default subagent model${price(defaultModel)} costs more per input token than this session's model${price(sessionModel)}. ` +
		"That may be deliberate, but for routine or mechanical tasks consider passing a cheaper listed model in the `model` field."
	);
}

/**
 * One line informing the main model when the user has manually pinned the
 * subagent default via the `subagentModel` setting — so the model knows what
 * subagents run on, and (when that model is a different provider than the
 * session) that it can keep a subagent's inherited transcript on this provider
 * by passing a listed same-provider model. Silent for the automatic default and
 * for Claude Code's env var, which are not the user's manual per-harness choice.
 */
export function settingOverrideNotice({ sessionModel, defaultModel, defaultSource, configured }: MenuOptions): string | undefined {
	// Only when the setting is actually in effect: a stale cross-provider setting
	// that was overridden resolves to an automatic/session model (defaultSource
	// != "default"), and its user-facing "set for a different provider" warning
	// already explains the override — no "runs on it" line for the model then.
	if (configured?.source !== "subagentModel setting" || defaultSource !== "default" || !defaultModel) return undefined;
	const cross = sessionModel && crossesProvider(defaultModel, sessionModel);
	return (
		`The user pinned the subagent default to ${spec(defaultModel)} via the subagentModel setting; ` +
		"subagents run on it unless you pass a different model in the `model` field" +
		(cross
			? ` — it is a different provider than this session (${spec(sessionModel as Model<Api>)}), so a subagent's inherited transcript goes to that provider; pass a listed same-provider model to keep it here.`
			: ".")
	);
}

/** The every-turn reminder body. Kept short: its tokens are paid on every call. */
export function subagentModelsReminder(options: MenuOptions): string {
	const menu = subagentModelMenu(options);
	const setting = settingOverrideNotice(options);
	const warning = defaultCostsMoreWarning(options);
	return [
		"Models for the subagent/workflow `model` field (omit it to use the default; set the default with /subagent):",
		...menu,
		...(setting ? [setting] : []),
		...(warning ? [warning] : []),
		"Aliases sonnet|opus|haiku|fable resolve within this session's provider — by name when a model carries it, else as the tier it names " +
			'(haiku: the cheapest capable model, sonnet: the cheapest workhorse-class model, opus/fable: this session\'s model); "inherit" means the session model. ' +
			"Any exact provider/model-id the user asked for also works, even from another provider (that is announced to the user) or unlisted here — this is a menu, not a whitelist.",
	].join("\n");
}

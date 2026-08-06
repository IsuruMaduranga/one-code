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
 *   session's provider** (and contained route/model family on gateways); where the name
 *   matches nothing, the session model serves and the parent says so.
 * - An exact model reference resolves anywhere — the user (or an agent file the
 *   user installed) naming a model is choosing it — but crossing providers is
 *   announced, never silent.
 * - A configured default that cannot resolve degrades to the session model with
 *   a notice naming the knob; without one, a reviewed same-provider role profile
 *   chooses an economical default before the session fallback. Only a bad
 *   *per-call* request errors, because the model can read the menu and retry.
 *
 * The menu keeps the main model informed without dumping a 300-model gateway
 * catalog into every request: vendor-contained, variant- and unpriced-filtered,
 * dated duplicates collapsed, capped — and explicitly *not* a whitelist, since
 * resolution accepts any available model whether or not it was listed.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	allowsDynamicSubagentSelection,
	findConfigured,
	findRoleProfileModel,
	hasSmallModelName,
	hintRank,
	modelIdentity,
	modelsContainedToSession,
	pricedInput,
} from "../lib/model-policy.ts";

/**
 * Cross-extension channel carrying the resolved default subagent model, so the
 * banner can show it when it differs from the session model (jiti isolates
 * module state, so this goes over `pi.events`).
 */
export const SUBAGENT_STATUS_CHANNEL = "pincer:subagent-status";

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

/** Claude Code's Agent-tool aliases, resolved as name matches within the session's provider. */
const CLAUDE_CODE_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);

export type SubagentModelSource = "call" | "agent" | "default" | "automatic" | "session";

export interface ResolveInput {
	/** Per-call `model` param — chosen by the main model. */
	requested?: string;
	/** The agent definition's frontmatter `model`. */
	agentModel?: string;
	/** CLAUDE_CODE_SUBAGENT_MODEL / `subagentModel` setting, user or managed scope. */
	configuredDefault?: string;
	sessionModel?: Model<Api>;
	available: Model<Api>[];
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
	/** One-line warnings the parent should surface (fallbacks, provider crossings). */
	notices: string[];
}

const spec = (model: Model<Api>): string => `${model.provider}/${model.id}`;

const isDated = (id: string): boolean => /-20\d{6}$/.test(id);

/**
 * Resolve a Claude Code alias by name within the contained set, preferring
 * undated alias ids and then the newest id. Returns undefined off-family —
 * "sonnet" on a Groq session names nothing, and inventing a mapping would be
 * choosing a model the user never described.
 */
function resolveAlias(alias: string, contained: Model<Api>[]): Model<Api> | undefined {
	const matches = contained.filter((model) => model.id.toLowerCase().includes(alias));
	if (matches.length === 0) return undefined;
	const undated = matches.filter((model) => !isDated(model.id));
	const pool = undated.length > 0 ? undated : matches;
	return pool.sort((a, b) => b.id.localeCompare(a.id))[0];
}

/** Whether an explicit model leaves the session's provider/route/family boundary. */
export function crossesProvider(model: Model<Api>, sessionModel: Model<Api>): boolean {
	if (model.provider !== sessionModel.provider) return true;
	return modelIdentity(model).containment !== modelIdentity(sessionModel).containment;
}

export function resolveSubagentModel(input: ResolveInput): SubagentModelResolution {
	const { available, sessionModel } = input;
	const notices: string[] = [];

	const chain: { value: string; source: SubagentModelSource; knob: string }[] = [];
	if (input.requested) chain.push({ value: input.requested, source: "call", knob: "the model field" });
	if (input.agentModel) chain.push({ value: input.agentModel, source: "agent", knob: "the agent file's model" });
	if (input.configuredDefault) {
		chain.push({ value: input.configuredDefault, source: "default", knob: "the configured subagent default" });
	}

	const contained = sessionModel ? modelsContainedToSession(available, sessionModel) : [];
	let suppressAutomatic = false;

	for (const entry of chain) {
		const wanted = entry.value.trim();
		if (!wanted || wanted.toLowerCase() === "inherit") {
			suppressAutomatic = true; // explicit "use the session model"
			break;
		}

		const alias = wanted.toLowerCase();
		if (CLAUDE_CODE_ALIASES.has(alias)) {
			const resolved = resolveAlias(alias, contained);
			if (resolved) return { model: resolved, source: entry.source, notices };
			notices.push(
				`No "${alias}" model exists within ${sessionModel ? spec(sessionModel) : "this session"} — the session model runs this subagent instead.`,
			);
			suppressAutomatic = true;
			break;
		}

		const resolved = findConfigured(available, wanted);
		if (resolved) {
			if (sessionModel && crossesProvider(resolved, sessionModel)) {
				notices.push(
					`Subagent model ${spec(resolved)} is a different provider/family than this session (${spec(sessionModel)}) — it was named via ${entry.knob}, so it is honored.`,
				);
			}
			return { model: resolved, source: entry.source, notices };
		}

		if (entry.source === "call") {
			// The main model chose this string; give it the menu and let it retry.
			return { source: "call", unresolved: wanted, notices };
		}
		// An explicit choice failed; automatic selection would substitute a model
		// nobody described, so the remaining chain and the session model serve.
		suppressAutomatic = true;
		notices.push(
			entry.source === "agent"
				? `Subagent model "${wanted}" (from ${entry.knob}) is not available — falling back to the configured default or the session model.`
				: `Subagent model "${wanted}" (from ${entry.knob}) is not available — the session model runs this subagent instead.`,
		);
	}

	// Automatic selection is a cost optimisation, so it needs price evidence:
	// with either price unknown there is no demonstrable saving, and the profile
	// order alone could silently *upgrade* a cheap session (haiku → sonnet).
	const sessionPrice = sessionModel ? pricedInput(sessionModel) : undefined;
	if (sessionModel && sessionPrice !== undefined && !suppressAutomatic) {
		const isDifferentAndCheaper = (model: Model<Api>) => {
			if (spec(model) === spec(sessionModel)) return false;
			const candidatePrice = pricedInput(model);
			return candidatePrice !== undefined && candidatePrice < sessionPrice;
		};
		const profiled = findRoleProfileModel(available, sessionModel, "subagent", isDifferentAndCheaper);
		if (profiled) return { model: profiled, source: "automatic", notices };

		// Price-ranked fallback for a stale profile. A name hint is required and
		// ranks first: raw cheapest would pick nano/lite-tier (or wholly unknown)
		// models as the default *coding* worker, so mini-class wins over a cheaper
		// nano, and a model nobody labelled small never wins at all.
		if (allowsDynamicSubagentSelection(sessionModel)) {
			const cheaper = contained
				.map((model) => ({ model, price: pricedInput(model), rank: hintRank(model) }))
				.filter((entry): entry is { model: Model<Api>; price: number; rank: number } => entry.price !== undefined)
				.filter((entry) => spec(entry.model) !== spec(sessionModel))
				.filter((entry) => entry.price < sessionPrice && hasSmallModelName(entry.model))
				.sort((a, b) => a.rank - b.rank || a.price - b.price)[0]?.model;
			if (cheaper) return { model: cheaper, source: "automatic", notices };
		}
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
export function subagentModelMenu({ available, sessionModel, defaultModel, defaultSource, maxCheaper = 3 }: MenuOptions): string[] {
	const lines: string[] = [];
	const listed = new Set<string>();
	const add = (model: Model<Api>, label: string) => {
		if (listed.has(spec(model))) return;
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
			.filter(
				(entry) =>
					!isDated(entry.model.id) ||
					!contained.some((other) => other.id !== entry.model.id && entry.model.id.startsWith(other.id)),
			)
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

/** The every-turn reminder body. Kept short: its tokens are paid on every call. */
export function subagentModelsReminder(options: MenuOptions): string {
	const menu = subagentModelMenu(options);
	const warning = defaultCostsMoreWarning(options);
	return [
		"Models for the subagent/workflow `model` field (omit it to use the default; set the default with /subagent):",
		...menu,
		...(warning ? [warning] : []),
		'Aliases sonnet|opus|haiku|fable resolve within this session\'s provider; "inherit" means the session model. ' +
			"Any exact provider/model-id the user asked for also works, even from another provider (that is announced to the user) or unlisted here — this is a menu, not a whitelist.",
	].join("\n");
}

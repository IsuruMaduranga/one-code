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
 *   session's provider** (and upstream vendor, on gateways); where the name
 *   matches nothing, the session model serves and the parent says so.
 * - An exact model reference resolves anywhere — the user (or an agent file the
 *   user installed) naming a model is choosing it — but crossing providers is
 *   announced, never silent.
 * - A configured default that cannot resolve degrades to the session model with
 *   a notice naming the knob; only a bad *per-call* request errors, because the
 *   model that wrote it can read the menu and retry.
 *
 * The menu keeps the main model informed without dumping a 300-model gateway
 * catalog into every request: vendor-contained, variant- and unpriced-filtered,
 * dated duplicates collapsed, capped — and explicitly *not* a whitelist, since
 * resolution accepts any available model whether or not it was listed.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	findConfigured,
	isSelectableVariant,
	pricedInput,
	vendorOf,
} from "../auto-mode/model-select.ts";

/**
 * Cross-extension channel carrying the resolved default subagent model, so the
 * banner can show it when it differs from the session model (jiti isolates
 * module state, so this goes over `pi.events`).
 */
export const SUBAGENT_STATUS_CHANNEL = "pincer:subagent-status";

export interface SubagentStatus {
	/** `provider/id`, set only when the default differs from the session model. */
	model?: string;
}

/** Claude Code's Agent-tool aliases, resolved as name matches within the session's provider. */
const CLAUDE_CODE_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);

export type SubagentModelSource = "call" | "agent" | "default" | "session";

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

/** Models the session is contained to: same provider, and same vendor on a gateway. */
function containedModels(available: Model<Api>[], sessionModel: Model<Api>): Model<Api>[] {
	const vendor = vendorOf(sessionModel);
	return available.filter(
		(model) =>
			model.provider === sessionModel.provider &&
			isSelectableVariant(model) &&
			(vendor === undefined || vendorOf(model) === vendor),
	);
}

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

/** Whether using `model` from `sessionModel`'s session leaves its provider or vendor. */
export function crossesProvider(model: Model<Api>, sessionModel: Model<Api>): boolean {
	if (model.provider !== sessionModel.provider) return true;
	const sessionVendor = vendorOf(sessionModel);
	return sessionVendor !== undefined && vendorOf(model) !== sessionVendor;
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

	const contained = sessionModel ? containedModels(available, sessionModel) : [];

	for (const entry of chain) {
		const wanted = entry.value.trim();
		if (!wanted || wanted.toLowerCase() === "inherit") break; // explicit "use the session model"

		const alias = wanted.toLowerCase();
		if (CLAUDE_CODE_ALIASES.has(alias)) {
			const resolved = resolveAlias(alias, contained);
			if (resolved) return { model: resolved, source: entry.source, notices };
			// Off-family alias: the session model serves rather than the name being
			// stretched across providers. Falls through to the next chain entry
			// only if this one was empty, which it is not — so break to session.
			notices.push(
				`No "${alias}" model exists on ${sessionModel ? spec(sessionModel).split("/")[0] : "this provider"} — the session model runs this subagent instead.`,
			);
			break;
		}

		const resolved = findConfigured(available, wanted);
		if (resolved) {
			if (sessionModel && crossesProvider(resolved, sessionModel)) {
				notices.push(
					`Subagent model ${spec(resolved)} is a different provider than this session (${spec(sessionModel)}) — it was named via ${entry.knob}, so it is honored.`,
				);
			}
			return { model: resolved, source: entry.source, notices };
		}

		if (entry.source === "call") {
			// The main model chose this string; give it the menu and let it retry.
			return { source: "call", unresolved: wanted, notices };
		}
		notices.push(
			`Subagent model "${wanted}" (from ${entry.knob}) is not available — the session model runs this subagent instead.`,
		);
	}

	if (sessionModel) return { model: sessionModel, source: "session", notices };
	return { model: available[0], source: "session", notices };
}

export interface MenuOptions {
	available: Model<Api>[];
	sessionModel?: Model<Api>;
	/** The resolved default (configured default if usable, else the session model). */
	defaultModel?: Model<Api>;
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
export function subagentModelMenu({ available, sessionModel, defaultModel, maxCheaper = 3 }: MenuOptions): string[] {
	const lines: string[] = [];
	const listed = new Set<string>();
	const add = (model: Model<Api>, label: string) => {
		if (listed.has(spec(model))) return;
		listed.add(spec(model));
		lines.push(`- ${spec(model)}${price(model)} — ${label}`);
	};

	if (defaultModel) {
		add(defaultModel, sessionModel && spec(defaultModel) === spec(sessionModel)
			? "the default (this session's model)"
			: "the configured default");
	}
	if (sessionModel) add(sessionModel, "this session's model");

	if (sessionModel) {
		const contained = containedModels(available, sessionModel).filter((model) => !listed.has(spec(model)));
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

/** The every-turn reminder body. Kept short: its tokens are paid on every call. */
export function subagentModelsReminder(options: MenuOptions): string {
	const menu = subagentModelMenu(options);
	return [
		"Models for the subagent/workflow `model` field (omit it to use the default):",
		...menu,
		'Aliases sonnet|opus|haiku|fable resolve within this session\'s provider; "inherit" means the session model. ' +
			"Any exact provider/model-id the user asked for also works, even from another provider (that is announced to the user) or unlisted here — this is a menu, not a whitelist.",
	].join("\n");
}

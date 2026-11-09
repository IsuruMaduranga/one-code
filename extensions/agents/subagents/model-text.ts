/**
 * What subagent model selection needs from a profile (types only), for the
 * Agent tool and workflow agents alike: the notices a resolution leaves, the
 * expensive-model gate, and the model menu with its notes. The base resolves
 * (model-select.ts) and lists the models; models are named by their
 * `provider/id` spec, and prices are dollars per million input tokens.
 */

import type { SubagentModelSource } from "../../lib/models/subagent-model.ts";

/** Where a choice in the resolution chain came from, other than the automatic pick and the session. */
export type ChainSource = "call" | "agent" | "default";

/** What a resolution noticed on the way. `session` is the session model's spec, when there is one. */
export type SubagentModelNotice =
	/** No model carries the alias in the session's provider family; it resolved as the tier it names. */
	| { kind: "aliasAsTier"; alias: string; session?: string; resolved: string }
	/** No model carries the alias and nothing in the family serves its tier. */
	| { kind: "aliasMissing"; alias: string; session?: string }
	/** The call named a text-only model on a session that works with images. */
	| { kind: "textOnlyCall"; model: string }
	/** A standing choice named a text-only model on a session that works with images; another runs. */
	| { kind: "textOnly"; model: string; source: ChainSource }
	/** The agent file names a model of another provider on a non-Claude session; a same-provider one runs. */
	| { kind: "agentOtherProvider"; model: string; session: string }
	/** The configured default was set for another provider; a same-provider one runs. */
	| { kind: "staleDefault"; model: string; session: string }
	/** An explicit choice of another provider, honored. */
	| { kind: "otherProviderHonored"; model: string; session: string; source: ChainSource }
	/** The call's model is not available; the chain goes on. */
	| { kind: "callUnavailable"; wanted: string }
	/** A standing choice's model is not available; the chain goes on. */
	| { kind: "unavailable"; wanted: string; source: ChainSource };

/** Why a model is on the menu. */
export type MenuLabel = "automaticDefault" | "sessionDefault" | "configuredDefault" | "session" | "cheaper";

export interface SubagentModelsText {
	notice(notice: SubagentModelNotice): string;
	/** After a resolution that left notices: the model that runs, and which choice it came from. */
	runsOn(p: { model: string; source: SubagentModelSource }): string;
	/** The expensive-model gate: the call's model costs more per input token than the session's. */
	costsMore(p: { model: string; price: number; session: string; sessionPrice: number }): string;
	/** One menu line; `price` absent when the model is unpriced. */
	menuLine(p: { model: string; price?: number; label: MenuLabel }): string;
	/** The configured default costs more per input token than the session's model. */
	defaultCostsMore(p: { price: number; sessionPrice: number }): string;
	/** The user pinned the default with the setting; `otherProvider` is the session's spec when the pin is another provider's. */
	settingPinned(p: { model: string; otherProvider?: string }): string;
	/** A model this account refused, and the default it leaves (absent: the session's model). */
	refused(p: { model: string; newDefault?: string }): string;
	/** The models note in the first-message block: the menu lines and the notes about the default. */
	menu(p: { lines: string[]; notes: string[] }): string;
}

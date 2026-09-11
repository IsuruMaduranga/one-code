/**
 * Models this account cannot use, learned at runtime and shared across the
 * extensions that pick models automatically.
 *
 * The catalog says what a provider *offers*; only a request says what this
 * account may *run* (`openai-codex/gpt-5.3-codex-spark` is "not supported when
 * using Codex with a ChatGPT account"). The auto-mode classifier already learns
 * that on its first call and steps to the next candidate (`ClassifierState.
 * rejected`). Since subagents share the classifier's selection floor
 * (docs/decisions/model-policy.md, 2026-09-11) they land on the same first
 * pick — so what one role learns must reach the other, or every session's
 * first subagent fails on a model the classifier already gave up on.
 *
 * Extensions are jiti-isolated (no shared module state), so the fact travels on
 * `pi.events`: whoever learns it emits `MODEL_UNUSABLE_CHANNEL`; the auto-mode
 * gate adds it to its `rejected` set, the subagent and workflow extensions drop
 * it from the catalog they resolve against. Session-scoped by construction
 * (process memory) — an entitlement can change between sessions.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { modelSpec } from "./model-policy.ts";

export const MODEL_UNUSABLE_CHANNEL = "one-code:model-unusable";

export interface ModelUnusableEvent {
	/** `provider/id` of the model the account cannot run. */
	model: string;
	/** The provider's own words, for the notice. */
	reason: string;
	/** Which role found out. Informational — every listener records every event. */
	source: "classifier" | "subagent" | "workflow";
}

/** The catalog minus the models this session has found unusable. */
export function withoutUnusable(available: Model<Api>[], unusable: ReadonlySet<string>): Model<Api>[] {
	if (unusable.size === 0) return available;
	return available.filter((model) => !unusable.has(modelSpec(model)));
}

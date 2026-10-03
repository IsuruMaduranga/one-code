/**
 * Tool descriptions that follow the session, as Claude Code's do.
 *
 * Claude Code sends its strongest models short tool descriptions and its
 * weakest the long ones it wrote for Haiku 4.5; its Bash text also changes
 * with the permission mode. One Code keys the same split on the model's tier
 * (`working-docs/decisions/system-prompt.md`, "Four registers"): frontier and
 * workhorse get the short forms, cheap and tiny the long ones, on every
 * provider.
 *
 * pi copies a tool's description when the tool is registered, so a tool whose
 * text depends on the session is registered again when that text changes
 * (`registerVariantTool`). Re-registering keeps the tool's place in the active
 * set and in the tools array, and it happens only when the text differs, so
 * for a fixed model and mode the tools array stays byte-identical across turns.
 * The tier changes only with the model, which starts a new provider cache
 * anyway; a mode change is a user action and costs one miss, as it does in
 * Claude Code.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type PromptTier, resolveModelTier } from "./model-tier.ts";

/** Which of Claude Code's description forms a tool carries. */
export type DescriptionForm = "short" | "long";

/** Claude Code's short forms on frontier and workhorse; its long forms on cheap and tiny. */
export function descriptionForm(tier: PromptTier): DescriptionForm {
	return tier === "cheap" || tier === "tiny" ? "long" : "short";
}

/** The form for a session model (`CC_PROMPT_TIER` applies, as it does to the prompt). */
export function descriptionFormFor(model: Model<Api> | undefined, env: NodeJS.ProcessEnv = process.env): DescriptionForm {
	return descriptionForm(resolveModelTier(model, env));
}

// Every tool definition shape registerTool accepts; the concrete generics differ per tool.
type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Register `define(initial)` now, and return a setter that registers the tool
 * again with `define(next)` when `next` differs from the variant in force.
 * Repeated calls with the same variant do nothing, so callers can apply the
 * session's facts on every event that might change them.
 */
export function registerVariantTool<V>(pi: ExtensionAPI, initial: V, define: (variant: V) => AnyToolDefinition): (variant: V) => void {
	let current = initial;
	pi.registerTool(define(initial));
	return (next: V) => {
		if (next === current) return;
		current = next;
		pi.registerTool(define(next));
	};
}

/**
 * Call `apply` with the session model's description form at session start, on
 * a model change, and before each prompt (a turn opened another way still
 * carries the right text).
 */
export function followDescriptionForm(pi: ExtensionAPI, apply: (form: DescriptionForm) => void): void {
	pi.on("session_start", (_event, ctx) => apply(descriptionFormFor(ctx.model)));
	pi.on("model_select", (event) => apply(descriptionFormFor(event.model)));
	pi.on("before_agent_start", (_event, ctx) => {
		apply(descriptionFormFor(ctx.model));
	});
}

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
 * (`registerVariantTool`). This can also move a tool in pi's active tool
 * order, so only a model-tier change may re-register after the first request.
 * The tier changes with the model, which starts a new provider cache anyway.
 * Permission-mode variants freeze at the first request (bash/index.ts); live
 * changes ride reminders and the permission gate, never the cached tool list.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PromptTier } from "./model-tier.ts";
import { sessionModelTier } from "./session-model-tier.ts";

/** Which of Claude Code's description forms a tool carries. */
export type DescriptionForm = "short" | "long";

/** Claude Code's short forms on frontier and workhorse; its long forms on cheap and tiny. */
export function descriptionForm(tier: PromptTier): DescriptionForm {
	return tier === "cheap" || tier === "tiny" ? "long" : "short";
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
 * Register `tool` with the description `describe` gives the session model's
 * form, following it through the session: the one call each tool with a
 * short and a long form makes.
 */
export function registerFormTool(pi: ExtensionAPI, tool: AnyToolDefinition, describe: (form: DescriptionForm) => string): void {
	followDescriptionForm(pi, registerVariantTool<DescriptionForm>(pi, "short", (form) => ({ ...tool, description: describe(form) })));
}

/** Apply the frozen session tier's form only at session and model boundaries. */
export function followDescriptionForm(pi: ExtensionAPI, apply: (form: DescriptionForm) => void): void {
	const requestTier = sessionModelTier(pi);
	pi.on("session_start", () => apply(descriptionForm(requestTier())));
	pi.on("model_select", () => apply(descriptionForm(requestTier())));
}

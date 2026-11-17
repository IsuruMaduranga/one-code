/**
 * The type of a profile's OpenRouter routing defaults and their load check
 * (lib/request/openrouter-routing-defaults.ts applies them). A leaf with no
 * imports, so lib/profile/profile.ts can check the table without loading the
 * request modules.
 */

/** The routing a profile sets on one vendor's OpenRouter models. */
export interface OpenRouterRoutingDefault {
	/** The precisions OpenRouter may serve the model at (`provider.quantizations`), such as `["fp8", "bf16", "fp16", "fp32", "unknown"]`. */
	quantizations: readonly string[];
}

/** The values OpenRouter's `provider.quantizations` takes (its provider-routing docs). */
export const OPENROUTER_QUANTIZATIONS: ReadonlySet<string> = new Set(["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"]);

const ROUTING_DEFAULT_FIELDS: ReadonlySet<string> = new Set(["quantizations"]);

/** A model-id vendor as OpenRouter spells it: lowercase, no slash, no leading `~`. */
const VENDOR = /^[a-z0-9][a-z0-9._-]*$/;

/** What is wrong with a profile's `openRouterRouting` table, one sentence each; empty when it is usable. */
export function openRouterRoutingProblems(table: Readonly<Record<string, unknown>>): string[] {
	const problems: string[] = [];
	for (const [vendor, entry] of Object.entries(table)) {
		const where = `openRouterRouting "${vendor}"`;
		if (!VENDOR.test(vendor)) problems.push(`${where} is not a model-id vendor (the lowercase part before the slash, such as "deepseek")`);
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			problems.push(`${where} must be an object with a "quantizations" list`);
			continue;
		}
		for (const field of Object.keys(entry)) if (!ROUTING_DEFAULT_FIELDS.has(field)) problems.push(`${where} has an unknown field "${field}"`);
		const list = (entry as { quantizations?: unknown }).quantizations;
		if (!Array.isArray(list) || list.length === 0) {
			problems.push(`${where} needs a non-empty "quantizations" list`);
			continue;
		}
		const unknown = list.filter((value) => typeof value !== "string" || !OPENROUTER_QUANTIZATIONS.has(value));
		if (unknown.length > 0) problems.push(`${where} lists ${unknown.map((value) => JSON.stringify(value)).join(", ")}, which OpenRouter does not take (one of ${[...OPENROUTER_QUANTIZATIONS].join(", ")})`);
		if (new Set(list).size !== list.length) problems.push(`${where} lists a quantization twice`);
	}
	return problems;
}

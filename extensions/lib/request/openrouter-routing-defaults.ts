/**
 * OpenRouter routing defaults a profile declares per model-id vendor: today a
 * quantization floor, sent as `provider.quantizations` so OpenRouter picks only
 * among the endpoints that serve the model at one of the listed precisions.
 *
 * OpenRouter serves an open-weight model through many hosts and picks one by
 * price; several of the cheapest serve it at fp4. The floor removes those
 * before the pick. It keeps the session on one host: with the floor and
 * `x-session-id`, every request of a growing session went to one host and read
 * the cache as it did without the floor (DeepSeek V4.1 Flash and Qwen 3.8 27B,
 * 6 requests each, measured 2026-11-17, working-docs/findings/93-*.md). A list
 * without `"unknown"` drops the endpoints that declare no precision, among them
 * every Alibaba endpoint of Qwen's own models, which then fail every request
 * ("No allowed providers"): a profile lists `"unknown"` unless it means that.
 * To add a vendor, check in OpenRouter's endpoints listing that each of its
 * catalog models keeps a host at the floor, and measure a session on one.
 *
 * The value depends only on the model and the user's routing, so it is the
 * same on every request of a session, on its children and on its side calls
 * (they all build OpenRouter Chat Completions requests through the
 * `cache-marks` extension's provider registration). It never overrides the
 * user's routing: a `models.json` routing that sets `quantizations`, `only` or
 * `order` for the model gets nothing added, since a floor could empty a host
 * the user pinned. pi sends routing only on the Chat Completions API, so
 * OpenRouter's `anthropic/*` models never carry it.
 *
 * The table's type and its load check are lib/profile/openrouter-routing.ts.
 * When the floor leaves a model no host, OpenRouter refuses every request with
 * "No allowed providers"; `routingFloorFailureHint` words what the user sees
 * then (the tool-call-corruption guard shows it for the main session).
 *
 * `<envPrefix>_OPENROUTER_ROUTING_DEFAULTS=0` turns it off. No pi imports.
 */

import { knobValue } from "../profile/knobs.ts";
import type { OpenRouterRoutingDefault } from "../profile/openrouter-routing.ts";
import { brand, envName } from "../profile/brand.mjs";
import { activeProfile } from "../profile/profile.ts";
import { type CacheMarksModel, type OpenRouterRouting, withOpenRouterRouting } from "./openrouter-cache-marks.ts";

/** The knob that turns the defaults off (`<envPrefix>_OPENROUTER_ROUTING_DEFAULTS=0`). */
export const OPENROUTER_ROUTING_DEFAULTS_KNOB = "OPENROUTER_ROUTING_DEFAULTS";

/** Whether the defaults apply in `vars` (the process environment by default). */
export function openRouterRoutingDefaultsEnabled(vars: Readonly<Record<string, unknown>> = process.env): boolean {
	return knobValue(OPENROUTER_ROUTING_DEFAULTS_KNOB, vars) !== "0";
}

/** The routing fields that choose hosts themselves: a user who sets one has made the choice a floor would make. */
const USER_CHOICE_FIELDS = ["quantizations", "only", "order"] as const;

/**
 * The user's OpenRouter routing with `defaults` added: nothing when the
 * routing already sets `quantizations`, `only` or `order`. Returns `routing`
 * itself when nothing is added.
 */
export function withRoutingDefaults(routing: OpenRouterRouting | undefined, defaults: OpenRouterRoutingDefault | undefined): OpenRouterRouting | undefined {
	if (!defaults || USER_CHOICE_FIELDS.some((field) => routing?.[field] !== undefined)) return routing;
	return { ...routing, quantizations: [...defaults.quantizations] };
}

/**
 * `model` with its vendor's routing defaults from `table`, as a copy; the
 * model itself when it is not an OpenRouter Chat Completions model, its vendor
 * has no entry, or the user's routing already chooses.
 */
export function withOpenRouterRoutingDefaults<M extends CacheMarksModel>(model: M, table: ReadonlyMap<string, OpenRouterRoutingDefault>): M {
	return withOpenRouterRouting(model, (routing, vendor) => withRoutingDefaults(routing, table.get(vendor)));
}

/** The profile's routing defaults by vendor, or none when `<envPrefix>_OPENROUTER_ROUTING_DEFAULTS=0`. */
export function activeOpenRouterRouting(vars: Readonly<Record<string, unknown>> = process.env): ReadonlyMap<string, OpenRouterRoutingDefault> {
	return openRouterRoutingDefaultsEnabled(vars) ? activeProfile().openRouterRouting : new Map();
}

/** OpenRouter's refusal when no host of the model passes the request's routing filters. */
const NO_ALLOWED_PROVIDERS = /no allowed providers/i;

/**
 * What to tell the user when `model`'s request failed with `errorMessage`
 * because the floor from `table` left it no host: the cause, the off switch
 * and the models.json override. Undefined for any other error, or when the
 * floor was not applied to this model (another vendor, or the user's own
 * routing chose).
 */
export function routingFloorFailureHint<M extends CacheMarksModel>(model: M, errorMessage: string | undefined, table: ReadonlyMap<string, OpenRouterRoutingDefault>): string | undefined {
	if (!errorMessage || !NO_ALLOWED_PROVIDERS.test(errorMessage)) return undefined;
	const floored = withOpenRouterRoutingDefaults(model, table);
	if (floored === model) return undefined;
	const quantizations = ((floored.compat as { openRouterRouting: { quantizations: string[] } }).openRouterRouting.quantizations).join(", ");
	return `OpenRouter has no host that serves ${model.id} at the precisions ${brand.name} asks for (${quantizations}). Set ${envName(OPENROUTER_ROUTING_DEFAULTS_KNOB)}=0 to drop that floor, or set your own compat.openRouterRouting for this model in pi's models.json (quantizations, only or order), which replaces it.`;
}

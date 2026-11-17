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
 * `<envPrefix>_OPENROUTER_ROUTING_DEFAULTS=0` turns it off. Pure: no pi imports.
 */

import { knobValue } from "../profile/knobs.ts";
import type { OpenRouterRoutingDefault } from "../profile/openrouter-routing.ts";
import type { CacheMarksModel } from "./openrouter-cache-marks.ts";
import { OPENROUTER_CACHE_MARKS_API, OPENROUTER_PROVIDER } from "./openrouter-cache-marks.ts";

/** The knob that turns the defaults off (`<envPrefix>_OPENROUTER_ROUTING_DEFAULTS=0`). */
export const OPENROUTER_ROUTING_DEFAULTS_KNOB = "OPENROUTER_ROUTING_DEFAULTS";

/** Whether the defaults apply in `vars` (the process environment by default). */
export function openRouterRoutingDefaultsEnabled(vars: Readonly<Record<string, unknown>> = process.env): boolean {
	return knobValue(OPENROUTER_ROUTING_DEFAULTS_KNOB, vars) !== "0";
}

type Routing = Record<string, unknown>;

/** The routing fields that choose hosts themselves: a user who sets one has made the choice a floor would make. */
const USER_CHOICE_FIELDS = ["quantizations", "only", "order"] as const;

/**
 * The user's OpenRouter routing with `defaults` added: nothing when the
 * routing already sets `quantizations`, `only` or `order`. Returns `routing`
 * itself when nothing is added.
 */
export function withRoutingDefaults(routing: Routing | undefined, defaults: OpenRouterRoutingDefault | undefined): Routing | undefined {
	if (!defaults || USER_CHOICE_FIELDS.some((field) => routing?.[field] !== undefined)) return routing;
	return { ...routing, quantizations: [...defaults.quantizations] };
}

/**
 * `model` with its vendor's routing defaults from `table`, as a copy; the
 * model itself when it is not an OpenRouter Chat Completions model, its vendor
 * has no entry, or the user's routing already chooses.
 */
export function withOpenRouterRoutingDefaults<M extends CacheMarksModel>(model: M, table: ReadonlyMap<string, OpenRouterRoutingDefault>): M {
	if (model.provider !== OPENROUTER_PROVIDER || model.api !== OPENROUTER_CACHE_MARKS_API) return model;
	const defaults = table.get(model.id.replace(/^~/, "").split("/")[0]);
	if (!defaults) return model;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	const routing = compat.openRouterRouting as Routing | undefined;
	const next = withRoutingDefaults(routing, defaults);
	if (next === routing) return model;
	return { ...model, compat: { ...compat, openRouterRouting: next } };
}

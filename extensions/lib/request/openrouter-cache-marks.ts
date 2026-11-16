/**
 * Explicit cache breakpoints on OpenRouter's open-weight models.
 *
 * OpenRouter serves an open-weight model through many third-party hosts and
 * keeps a session on the host that served its first request (`x-session-id`,
 * which pi-ai sends). Most hosts reuse a prefix on their own, but some read
 * nothing unless the request carries Anthropic-style `cache_control`
 * breakpoints: Reka on Qwen 3.8 27B read 0 on every request of a session, a
 * byte-identical repeat included, and read the cache once the breakpoints were
 * there; Alibaba, Qwen's own host, reads further with them. Hosts that cache by
 * themselves (Wafer, Modal, InferenceNet, MiniMax) read the same with or
 * without them (findings §93, measured 2026-11-16).
 *
 * pi-ai already has the placement: `compat.cacheControlFormat: "anthropic"`
 * marks the system prompt, the last tool and the last conversation message, as
 * it does for OpenRouter's `anthropic/*` Chat Completions models. Its catalog
 * sets the flag only there, so this module sets it on the model a request is
 * built from, the way message-threads.ts turns threads off: never on the
 * registry's shared objects.
 *
 * Only the vendors in `MARKED_VENDORS` take the marks: those whose OpenRouter
 * hosts were measured accepting them. Every other vendor stays at pi's default,
 * so an untested host never starts failing or billing differently because of
 * us. To add a vendor, replay a logged request on one of its models through
 * OpenRouter with the marks, pinned to its hosts (`provider.order`,
 * `allow_fallbacks: false`), see each accept them and read the cache on the
 * next request, record that in the findings, then add the vendor here.
 *
 * `<envPrefix>_OPENROUTER_CACHE_MARKS=0` turns these marks off alone;
 * `<envPrefix>_CACHE_MARKS=0` turns them off with the Anthropic ones.
 */

import { knobValue } from "../profile/knobs.ts";

/** The pi provider and API this applies to. */
export const OPENROUTER_PROVIDER = "openrouter";
export const OPENROUTER_CACHE_MARKS_API = "openai-completions";

/**
 * Model-id vendors (the part before the slash, without a leading `~`) whose
 * models take the marks, each measured on 2026-11-16: qwen (Reka, Alibaba,
 * Wafer), deepseek (InferenceNet, OpenInference), z-ai (Wafer), minimax
 * (MiniMax).
 */
export const MARKED_VENDORS: ReadonlySet<string> = new Set(["qwen", "deepseek", "z-ai", "minimax"]);

/** The knob that turns these marks off alone (`<envPrefix>_OPENROUTER_CACHE_MARKS=0`), and the one that turns every cache mark off. */
export const OPENROUTER_CACHE_MARKS_KNOB = "OPENROUTER_CACHE_MARKS";
export const CACHE_MARKS_KNOB = "CACHE_MARKS";

/** Whether the OpenRouter marks are on in `vars` (the process environment by default): neither knob is `0`. */
export function openRouterCacheMarksEnabled(vars: Readonly<Record<string, unknown>> = process.env): boolean {
	return knobValue(CACHE_MARKS_KNOB, vars) !== "0" && knobValue(OPENROUTER_CACHE_MARKS_KNOB, vars) !== "0";
}

/** The fields of a pi `Model` this module reads. */
export interface CacheMarksModel {
	id: string;
	api: string;
	provider: string;
	compat?: unknown;
}

/** Whether pi should mark `model`'s requests: an OpenRouter Chat Completions model of a measured vendor whose compat names no format. */
export function takesOpenRouterCacheMarks(model: CacheMarksModel): boolean {
	if (model.provider !== OPENROUTER_PROVIDER || model.api !== OPENROUTER_CACHE_MARKS_API) return false;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	if (compat.cacheControlFormat !== undefined) return false;
	const vendor = model.id.replace(/^~/, "").split("/")[0];
	return MARKED_VENDORS.has(vendor);
}

/** `model` with Anthropic-style breakpoints on, as a copy; the model itself when it does not take them. */
export function withOpenRouterCacheMarks<M extends CacheMarksModel>(model: M): M {
	if (!takesOpenRouterCacheMarks(model)) return model;
	return { ...model, compat: { ...((model.compat ?? {}) as Record<string, unknown>), cacheControlFormat: "anthropic" } };
}

/** The `pi.registerProvider("openrouter", …)` config that marks the open-weight models' requests. */
export interface OpenRouterCacheMarksConfig<M extends CacheMarksModel, C, O, R> {
	api: typeof OPENROUTER_CACHE_MARKS_API;
	streamSimple: (model: M, context: C, options?: O) => R;
}

/**
 * A provider config whose stream hands every OpenRouter Chat Completions
 * request to `stream` (pi-ai's implementation, the one pi's own `openrouter`
 * provider dispatches to) with the model passed through
 * `withOpenRouterCacheMarks`. pi's provider composer calls it for that
 * provider's `openai-completions` models only, for the session loop, in-process
 * children and side calls alike (side calls send through the model registry),
 * with auth and headers already resolved; its `anthropic-messages` models stay
 * with pi's provider.
 */
export function openRouterCacheMarksProvider<M extends CacheMarksModel, C, O, R>(stream: (model: M, context: C, options?: O) => R): OpenRouterCacheMarksConfig<M, C, O, R> {
	return { api: OPENROUTER_CACHE_MARKS_API, streamSimple: (model, context, options) => stream(withOpenRouterCacheMarks(model), context, options) };
}

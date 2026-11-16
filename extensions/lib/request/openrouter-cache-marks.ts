/**
 * Explicit cache breakpoints on OpenRouter's open-weight models (pure).
 *
 * OpenRouter serves an open-weight model (Qwen, DeepSeek, GLM, Kimi, MiniMax
 * and the rest) through many third-party hosts and keeps a session on the host
 * that served its first request (`x-session-id`, which pi-ai sends). Most hosts
 * reuse a prefix on their own, but some read nothing unless the request carries
 * Anthropic-style `cache_control` breakpoints: Reka on Qwen 3.8 27B read 0 on
 * every request of a session, a byte-identical repeat included, and read the
 * cache once the breakpoints were there; Alibaba, Qwen's own host, reads
 * further with them. Hosts that cache by themselves (Wafer, Modal,
 * InferenceNet, MiniMax) read the same with or without them, and none rejected
 * them (working-docs/findings, "OpenRouter hosts that cache only with
 * breakpoints", 2026-11-16).
 *
 * pi-ai already has the placement: `compat.cacheControlFormat: "anthropic"`
 * marks the system prompt, the last tool and the last conversation message, as
 * it does for OpenRouter's `anthropic/*` Chat Completions models. Its catalog
 * sets the flag only there, so this module sets it on the model a request is
 * built from, the way message-threads.ts turns threads off: never on the
 * registry's shared objects.
 *
 * Kept at pi's default: Anthropic (pi already marks), Google (OpenRouter
 * bills Gemini's explicit cache writes and storage, while its implicit cache is
 * free), OpenAI (its own breakpoint format, and implicit caching otherwise) and
 * OpenRouter's own routers (`openrouter/auto` can land on any of those).
 */

/** The pi provider and API this applies to. */
export const OPENROUTER_PROVIDER = "openrouter";
export const OPENROUTER_CACHE_MARKS_API = "openai-completions";

/** Model-id vendors (the part before the slash, without a leading `~`) left at pi's default. */
const DEFAULT_VENDORS: ReadonlySet<string> = new Set(["anthropic", "google", "openai", "openrouter"]);

/** The fields of a pi `Model` this module reads. */
export interface CacheMarksModel {
	id: string;
	api: string;
	provider: string;
	compat?: unknown;
}

/** Whether pi should mark `model`'s requests: an OpenRouter Chat Completions model of an open-weight vendor whose compat names no format. */
export function takesOpenRouterCacheMarks(model: CacheMarksModel): boolean {
	if (model.provider !== OPENROUTER_PROVIDER || model.api !== OPENROUTER_CACHE_MARKS_API) return false;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	if (compat.cacheControlFormat !== undefined) return false;
	const vendor = model.id.replace(/^~/, "").split("/")[0];
	return !DEFAULT_VENDORS.has(vendor);
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

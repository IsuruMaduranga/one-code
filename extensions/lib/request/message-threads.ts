/**
 * Anthropic message threads stay off (pure): every request One Code sends to
 * the Messages API carries the whole conversation, as it did on pi 1.5.0.
 *
 * pi-ai 1.5.1 sends a `thread` field on `anthropic-messages` requests whose
 * model's `compat.supportsMessageThreads` is true (by default the `anthropic`
 * provider on api.anthropic.com): a `create`, then `continue` requests that
 * carry only the new messages and no `system` or `tools`. It does so after
 * the payload hooks, and our `anthropic-beta` header (request/context-management)
 * has no threads beta, so the first request of each session key was a 400
 * that pi resent without the field (working-docs/findings/85-pi-1.5.2.md).
 * Adopting threads is a separate decision; until then the flag is false on
 * every model object a request is built from:
 *
 * - the session loop and in-process children: `threadlessAnthropicProvider`,
 *   registered for the `anthropic` provider by request/ledger/wire.ts, wraps
 *   the stream pi's model runtime calls for it;
 * - side calls: each goes through `completeThreadless`, which passes its model
 *   through `withoutMessageThreads`.
 *
 * Both hand the request to a pi-ai stream that sends exactly the credentials
 * pi's own provider would have sent (lib/request/anthropic-stream.ts). On pi
 * before 1.5.1 the field means nothing; the wrappers then change nothing.
 */

/** The pi-ai API that has message threads. */
export const THREADED_API = "anthropic-messages";

/** The fields of a pi `Model` this module reads. */
export interface ThreadModel {
	api: string;
	compat?: unknown;
}

/**
 * `model` with message threads off: a copy with `compat.supportsMessageThreads`
 * false for an `anthropic-messages` model, the model itself otherwise or when
 * the flag is already false. Never mutates `model`: the registry's objects are
 * shared by everything in the process.
 */
export function withoutMessageThreads<M extends ThreadModel>(model: M): M {
	if (model.api !== THREADED_API) return model;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	if (compat.supportsMessageThreads === false) return model;
	return { ...model, compat: { ...compat, supportsMessageThreads: false } };
}

/** The `pi.registerProvider` config that keeps threads off for one provider's `anthropic-messages` models. */
export interface ThreadlessProviderConfig<M extends ThreadModel, C, O, R> {
	api: typeof THREADED_API;
	streamSimple: (model: M, context: C, options?: O) => R;
}

/**
 * A provider config for `pi.registerProvider(<provider>, …)` whose stream
 * hands every request to `stream` (pi-ai's Anthropic Messages implementation,
 * lib/request/anthropic-stream.ts) with threads off. pi's provider composer
 * calls it only for that provider's models on `anthropic-messages`, with the
 * auth, headers and payload hook already resolved in `options`; a registration without `models` keeps the provider's
 * catalog, auth and name (pi 1.0 to 1.5, `core/provider-composer.ts`).
 */
export function threadlessAnthropicProvider<M extends ThreadModel, C, O, R>(stream: (model: M, context: C, options?: O) => R): ThreadlessProviderConfig<M, C, O, R> {
	return { api: THREADED_API, streamSimple: (model, context, options) => stream(withoutMessageThreads(model), context, options) };
}

/**
 * The streams One Code hands model requests to with Anthropic message threads
 * off (lib/request/message-threads.ts), sending exactly the credentials pi's
 * own provider would have sent.
 *
 * - The session loop and in-process children: `threadlessAnthropicRegistration`
 *   wraps pi-ai's `anthropicMessagesApi()`, the implementation pi's built-in
 *   `anthropic` provider dispatches to (pi-ai providers/anthropic.js), and is
 *   registered for the `anthropic` provider (request/ledger/wire.ts).
 * - Side calls: `completeThreadless` sends through pi's model runtime
 *   (`ctx.modelRegistry.streamSimple`, pi 0.86 and later), which resolves the
 *   credential the session itself would use, routes virtual models, and
 *   dispatches to extension-registered providers (the threadless `anthropic`
 *   one included). pi-ai's compat entry point, used before, knew only its
 *   built-in APIs and filled an empty key from the environment, which pi's
 *   provider never does.
 *
 * - OpenRouter's open-weight models: `openRouterCacheMarksRegistration` wraps
 *   pi-ai's `openAICompletionsApi()` so their requests carry cache breakpoints
 *   (lib/request/openrouter-cache-marks.ts), registered for the `openrouter`
 *   provider by request/cache-marks. Side calls reach it through the registry.
 *
 * `anthropicMessagesApi` and `openAICompletionsApi` exist on every pi-ai in the
 * peer range (1.0.0 to 1.5.2, through `/compat`); when the running pi-ai lacks
 * one, it reads as undefined and pi's own provider stays in charge.
 */

import * as compat from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { credentialCause, credentialRefusalMessage, isCredentialRefusal } from "./credential-refusal.ts";
import { type ThreadlessProviderConfig, threadlessAnthropicProvider, withoutMessageThreads } from "./message-threads.ts";
import { type OpenRouterCacheMarksConfig, openRouterCacheMarksProvider } from "./openrouter-cache-marks.ts";

type Stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/** pi-ai's API implementations, read as optional: undefined when the running pi-ai lacks one. */
const piAi = compat as { anthropicMessagesApi?: () => { streamSimple: Stream }; openAICompletionsApi?: () => { streamSimple: Stream } };

/**
 * The `pi.registerProvider("anthropic", …)` config that keeps message threads
 * off: pi-ai's Anthropic Messages implementation with the model's threads off,
 * handed pi's resolved options untouched. Undefined when the running pi-ai has
 * no `anthropicMessagesApi`; registering nothing then leaves pi's provider as is.
 */
export function threadlessAnthropicRegistration(): ThreadlessProviderConfig<Model<Api>, TranscriptContext, SimpleStreamOptions, AssistantMessageEventStream> | undefined {
	if (typeof piAi.anthropicMessagesApi !== "function") return undefined;
	return threadlessAnthropicProvider(piAi.anthropicMessagesApi().streamSimple);
}

/**
 * The `pi.registerProvider("openrouter", …)` config that puts cache breakpoints
 * on the open-weight models: pi-ai's Chat Completions implementation (the one
 * pi's `openrouter` provider dispatches to) with the model's
 * `cacheControlFormat` set, handed pi's resolved options untouched. Undefined
 * when the running pi-ai has no `openAICompletionsApi`.
 */
export function openRouterCacheMarksRegistration(): OpenRouterCacheMarksConfig<Model<Api>, TranscriptContext, SimpleStreamOptions, AssistantMessageEventStream> | undefined {
	if (typeof piAi.openAICompletionsApi !== "function") return undefined;
	return openRouterCacheMarksProvider(piAi.openAICompletionsApi().streamSimple);
}

/** The slice of pi's model registry a side call sends through, and asks why a credential did not resolve. */
export type SideCallRegistry = Pick<ModelRegistry, "streamSimple" | "getApiKeyAndHeaders">;

/**
 * A side call's options. No `apiKey` or `env`: pi resolves the model's
 * credential itself, and `headers` are only the extra headers the call needs
 * (pi merges them over the resolved ones by name).
 */
export type SideCallOptions = Omit<SimpleStreamOptions, "apiKey" | "env">;

/** A side call's reply; `credentialError` is set, with the cause, when pi refused the model's credential. */
export type SideCallReply = AssistantMessage & { credentialError?: string };

/**
 * A side call: one request through pi's model runtime with message threads
 * off. A failure (no credentials, a provider error, an unknown api) comes back
 * as a reply with `stopReason: "error"` and pi's message, never as a throw.
 * A credential refusal comes back with its cause in `credentialError` and an
 * `errorMessage` that names the model, the cause and the fix
 * (credential-refusal.ts). Every side call goes through here
 * (message-threads.test.ts).
 */
export async function completeThreadless(registry: SideCallRegistry, model: Model<Api>, context: Context, options: SideCallOptions): Promise<SideCallReply> {
	const reply = await registry.streamSimple(withoutMessageThreads(model), context, options).result();
	if (reply.stopReason !== "error" || !isCredentialRefusal(reply.errorMessage)) return reply;
	const cause = await credentialCause(registry, model, reply.errorMessage!, options.signal);
	return { ...reply, errorMessage: credentialRefusalMessage(model, cause), credentialError: cause };
}

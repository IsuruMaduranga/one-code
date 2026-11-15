/**
 * The streams One Code hands Anthropic Messages requests to with message
 * threads off (lib/request/message-threads.ts), sending exactly the
 * credentials pi's own provider would have sent.
 *
 * pi-ai's compat `streamSimple` and `completeSimple` fill an empty
 * `options.apiKey` from the environment (`withEnvApiKey`: `ANTHROPIC_OAUTH_TOKEN`
 * or `ANTHROPIC_API_KEY` for the `anthropic` provider). pi's provider never
 * does: it resolves the credential once and dispatches straight to the API
 * implementation. So with `ANTHROPIC_AUTH_TOKEN` (a bearer header, no key) and
 * `ANTHROPIC_API_KEY` both exported, a compat call sent the bearer header and
 * an `x-api-key` header too, leaking the key to the token's gateway. Neither
 * stream here goes through that fill:
 *
 * - the session loop and in-process children: `threadlessAnthropicRegistration`
 *   wraps pi-ai's `anthropicMessagesApi()`, the implementation pi's built-in
 *   `anthropic` provider dispatches to (pi-ai providers/anthropic.js);
 * - side calls: `completeThreadless` sends a request that has no key of its
 *   own to the registered `anthropic-messages` API, the one compat itself
 *   would pick, and every other request to compat `completeSimple`.
 *
 * Both exports exist on every pi-ai in the peer range (1.0.0 to 1.5.2, through
 * `/compat`); one the running pi-ai lacks reads as undefined, and then pi's
 * own provider or compat stays in charge.
 */

import * as compat from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { THREADED_API, type ThreadlessProviderConfig, threadlessAnthropicProvider, withoutMessageThreads } from "./message-threads.ts";

type Stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/** pi-ai's exports, read as optional: a name the running pi-ai lacks is undefined. */
const piAi = compat as unknown as {
	anthropicMessagesApi?: () => { streamSimple: Stream };
	getApiProvider?: (api: Api) => { streamSimple: Stream } | undefined;
	normalizeContext?: (context: Context) => TranscriptContext;
};

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

/** Whether compat would fill this request's key from the environment, the step pi's provider never takes. */
function wouldFillEnvKey(model: Model<Api>, options: SimpleStreamOptions): boolean {
	if (model.api !== THREADED_API) return false;
	// Cloudflare's providers resolve their own auth inside compat; they stay there.
	if (model.provider.startsWith("cloudflare-")) return false;
	return !(typeof options.apiKey === "string" && options.apiKey.trim().length > 0);
}

/**
 * A side call's `completeSimple`, with message threads off and no credential
 * from the environment that pi's resolution did not choose. Every side call
 * goes through here (message-threads.test.ts).
 */
export function completeThreadless(model: Model<Api>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessage> {
	const target = withoutMessageThreads(model);
	if (wouldFillEnvKey(target, options) && typeof piAi.getApiProvider === "function" && typeof piAi.normalizeContext === "function") {
		const api = piAi.getApiProvider(THREADED_API);
		if (api) return api.streamSimple(target, piAi.normalizeContext(context), options).result();
	}
	return compat.completeSimple(target, context, options);
}

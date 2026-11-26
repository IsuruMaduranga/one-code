/** Whether a model is served through OpenRouter, and the guard's notice naming the upstream host that failed (the host lookup is lib/request/openrouter-generation.ts). */

import { avoidHostAdvice } from "../../lib/request/openrouter-host.ts";

/** Per model object: the stream detector asks on every chunk of every provider. */
const openRouterByModel = new WeakMap<object, boolean>();

export function isOpenRouter(model: { provider: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	if (model.provider === "openrouter") return true;
	const known = openRouterByModel.get(model);
	if (known !== undefined) return known;
	let result = false;
	try {
		const hostname = new URL(model.baseUrl ?? "").hostname;
		result = hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
	} catch {
		// No or malformed base URL: not OpenRouter.
	}
	openRouterByModel.set(model, result);
	return result;
}

/** What a stopped turn's notice ends on when there is no host to name. */
export const RETRY_ADVICE = "Send the request again, or switch models if it repeats.";

/** How the upstream provider failed: a blocked call, a call cut off mid-stream, or a stream gone silent. */
export type UpstreamFailure = "blocked-call" | "corrupt-stream" | { stalledSeconds: number };

/** The notice for a host that failed; `modelsFile` is pi's models file as shown to the user. */
export function toolCallCorruptionNotice(modelId: string, providerName: string | undefined, modelsFile: string, failure: UpstreamFailure = "blocked-call"): string {
	const stalled = typeof failure === "object";
	const what = stalled ? `stopped sending data for ${modelId} (no data for ${failure.stalledSeconds} s)` : `is damaging tool calls for ${modelId}`;
	const provider = providerName ? `${providerName} ${what}.` : `An OpenRouter host ${what}; it could not be identified.`;
	const outcome = failure === "blocked-call" ? "The call was blocked and the turn stopped." : stalled ? "The turn was stopped." : "The reply was cut off and the turn stopped.";
	const next = providerName ? `${avoidHostAdvice(providerName, modelsFile)} Or switch models.` : RETRY_ADVICE;
	return `${provider} ${outcome} ${next}`;
}

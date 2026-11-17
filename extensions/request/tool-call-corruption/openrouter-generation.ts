/** Whether a model is served through OpenRouter, and the guard's notice naming the upstream host that failed (the host lookup is lib/request/openrouter-generation.ts). */

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

/** How the upstream provider failed: a blocked call, a call cut off mid-stream, or a stream gone silent. */
export type UpstreamFailure = "blocked-call" | "corrupt-stream" | { stalledSeconds: number };

export function toolCallCorruptionNotice(modelId: string, providerName: string | undefined, failure: UpstreamFailure = "blocked-call"): string {
	const stalled = typeof failure === "object";
	const what = stalled ? `stopped streaming for ${modelId} (no data for ${failure.stalledSeconds} s)` : `is corrupting tool calls for ${modelId}`;
	const provider = providerName
		? `OpenRouter upstream provider ${providerName} ${what}.`
		: `An OpenRouter upstream provider ${what}; the provider could not be identified.`;
	const outcome = failure === "blocked-call" ? "The call was blocked and the turn stopped." : stalled ? "The turn was stopped." : "The reply was cut off and the turn stopped.";
	const ignore = JSON.stringify([providerName ?? "PROVIDER_NAME"]);
	return `${provider} ${outcome} Add the provider to compat.openRouterRouting.ignore for this model in pi's models.json ("ignore": ${ignore}), or switch models.`;
}

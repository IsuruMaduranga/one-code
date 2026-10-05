/** A best-effort attribution lookup, bounded across auth, retries, and response-body reads. */
export async function openRouterProviderName(
	generationId: string | undefined,
	getApiKey: () => Promise<string | undefined>,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (!generationId || signal.aborted) return;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	signal.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(cancel, 8_000);
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let releaseRetry: (() => void) | undefined;
	const stopped = new Promise<undefined>((resolve) => {
		controller.signal.addEventListener("abort", () => {
			clearTimeout(retryTimer);
			releaseRetry?.();
			resolve(undefined);
		}, { once: true });
	});
	const lookup = async (): Promise<string | undefined> => {
		let apiKey: string | undefined;
		try {
			apiKey = await getApiKey();
		} catch {
			return;
		}
		if (!apiKey || controller.signal.aborted) return;
		while (!controller.signal.aborted) {
			try {
				const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				if (response.ok) {
					const body = await response.json() as { data?: { provider_name?: unknown } } | null;
					const provider = body?.data?.provider_name;
					if (typeof provider === "string" && provider.trim()) return provider.trim();
				} else {
					await response.body?.cancel();
					if (response.status === 401 || response.status === 403) return;
				}
			} catch {
				// Generation metadata can lag or fail independently of the completed model call.
			}
			if (controller.signal.aborted) return;
			await new Promise<void>((resolve) => {
				releaseRetry = resolve;
				retryTimer = setTimeout(resolve, 1_000);
			});
		}
	};
	try {
		return await Promise.race([lookup(), stopped]);
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", cancel);
		controller.abort();
	}
}

export function isOpenRouter(model: { provider: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	if (model.provider === "openrouter") return true;
	try {
		const hostname = new URL(model.baseUrl ?? "").hostname;
		return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
	} catch {
		return false;
	}
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

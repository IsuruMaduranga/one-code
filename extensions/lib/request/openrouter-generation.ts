/**
 * OpenRouter's generation record: which host served a reply, looked up by the
 * generation id pi records on every assistant message. Used by the
 * tool-call-corruption guard's notice and by /doctor. Pure apart from the fetch.
 */

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** What the lookup needs of a model's credential: the key and the base URL requests for it go to. */
export interface GenerationAuth {
	apiKey?: string;
	baseUrl?: string;
}

/**
 * A model's resolved base URL without its trailing slash, or undefined when it
 * is not OpenRouter's own. A provider named `openrouter` can point at a proxy,
 * and the key must not leave for a host it was not issued for.
 */
export function openRouterApiBase(baseUrl: string | undefined): string | undefined {
	try {
		const url = new URL(baseUrl || OPENROUTER_BASE_URL);
		if (url.protocol !== "https:" || url.hostname !== "openrouter.ai") return;
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		// A malformed base URL is not OpenRouter's.
	}
}

/** The generation endpoint under a model's resolved base URL, or undefined when that URL is not OpenRouter's own. */
export function generationEndpoint(baseUrl: string | undefined, generationId: string): string | undefined {
	const base = openRouterApiBase(baseUrl);
	return base && `${base}/generation?id=${encodeURIComponent(generationId)}`;
}

/**
 * A best-effort attribution lookup, bounded across auth, retries, and response-body reads.
 * Skipped silently when the credential's base URL is not openrouter.ai.
 */
export async function openRouterProviderName(
	generationId: string | undefined,
	getAuth: () => Promise<GenerationAuth | undefined>,
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
		let auth: GenerationAuth | undefined;
		try {
			auth = await getAuth();
		} catch {
			return;
		}
		const apiKey = auth?.apiKey;
		const endpoint = generationEndpoint(auth?.baseUrl, generationId);
		if (!apiKey || !endpoint || controller.signal.aborted) return;
		while (!controller.signal.aborted) {
			try {
				const response = await fetch(endpoint, {
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

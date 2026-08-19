/**
 * fetch with a hard timeout (pure, no pi imports) — the AbortController +
 * unref'd timer boilerplate the plugin-marketplace fetches share.
 */

export async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

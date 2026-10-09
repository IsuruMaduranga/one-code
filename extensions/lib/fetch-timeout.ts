/**
 * fetch and read the response under one hard deadline (pure, no pi imports):
 * the timer runs until `read` settles, so a body that stalls after the headers
 * is cut off too, whatever `fetchImpl` does with the signal. `signal` aborts
 * early (a session shutting down). Shared by the plugin-marketplace fetches and
 * the model-catalog refresh; `fetchImpl` is the test seam, given the same signal.
 */
export async function fetchWithTimeout<T>(
	url: string,
	timeoutMs: number,
	read: (response: Response) => Promise<T>,
	options: { init?: RequestInit; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<T> {
	const controller = new AbortController();
	// Parsed up front: a malformed URL fails the call, never the timer callback.
	const host = new URL(url).host;
	const timer = setTimeout(() => controller.abort(new Error(`${host} did not answer within ${timeoutMs} ms`)), timeoutMs);
	timer.unref?.();
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const aborted = new Promise<never>((_, reject) => {
		const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
	try {
		const work = (async () => read(await (options.fetchImpl ?? fetch)(url, { ...options.init, signal })))();
		// Lost to the deadline, the work may still reject later: not unhandled.
		work.catch(() => {});
		return await Promise.race([work, aborted]);
	} finally {
		clearTimeout(timer);
	}
}

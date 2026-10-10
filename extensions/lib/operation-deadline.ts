/** Bound an awaited operation, including dependencies that do not accept an abort signal. */
export async function runWithDeadline<T>(
	call: (signal: AbortSignal) => Promise<T>,
	options: { signal?: AbortSignal; timeoutMs: number; message: string },
): Promise<T> {
	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	// A one-shot process must live until the awaited operation settles.
	const timer = setTimeout(() => controller.abort(new Error(options.message)), options.timeoutMs);
	let rejectAbort: () => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = () => reject(signal.reason);
		signal.addEventListener("abort", rejectAbort, { once: true });
	});
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return call(signal);
			}),
			aborted,
		]);
		signal.throwIfAborted();
		return result;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", rejectAbort);
	}
}

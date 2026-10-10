import { runWithDeadline } from "../lib/operation-deadline.ts";

/** Bound the provider-native transport, including auth, streamed bodies and source resolution. */
export const NATIVE_SEARCH_TIMEOUT_MS = 120_000;

export async function runNativeSearch<T>(
	call: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	return runWithDeadline(call, {
		signal,
		timeoutMs: NATIVE_SEARCH_TIMEOUT_MS,
		message: "Provider-native search did not answer within 120 seconds.",
	});
}

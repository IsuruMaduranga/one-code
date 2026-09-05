/**
 * Run `onAbort` when `signal` aborts — at once if it already has — and return
 * the remover to call once the awaited work is over, so the listener does not
 * outlive it. The idiom (check `aborted` first, `{ once: true }`, remove in
 * `finally`) was hand-rolled at every tool that awaits something abortable.
 */
export function whenAborted(signal: AbortSignal | undefined, onAbort: () => void): () => void {
	if (!signal) return () => {};
	if (signal.aborted) {
		onAbort();
		return () => {};
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

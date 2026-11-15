/**
 * Injectable timers (pure), so a timer-driven state machine is unit-tested
 * with fake timers, and the real unref'd adapters the extensions run them on.
 */

export interface TimerOps {
	/** Schedule `cb` after `ms`; return a handle for `clear`. */
	set(cb: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** `setTimeout` with the handle unref'd, so a pending idle timer never keeps a one-shot process alive. */
export const unrefTimers: TimerOps = {
	set: (cb, ms) => {
		const handle = setTimeout(cb, ms);
		handle.unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Run `tick` every `ms` on an unref'd interval; the returned function stops it. */
export function unrefEvery(ms: number, tick: () => void): () => void {
	const timer = setInterval(tick, ms);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Run `fire` once after `ms` on an unref'd timeout; the returned function cancels it. */
export function unrefAfter(ms: number, fire: () => void): () => void {
	const timer = setTimeout(fire, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

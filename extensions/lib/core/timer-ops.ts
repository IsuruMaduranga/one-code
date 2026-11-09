/**
 * An injectable timer (pure), so an idle-timer state machine is unit-tested
 * with fake timers, and the real adapter both recap and idle-compact run on.
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

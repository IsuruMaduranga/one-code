/**
 * One in-flight run per key (pure): a call while a run for its key is pending
 * shares that run's promise instead of starting another; once it settles, the
 * next call starts fresh. Used where two overlapping callers would otherwise
 * both pass an "is it there yet?" check across an await and duplicate work
 * that must happen once (a language server spawn, a consent dialog).
 */
export function singleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
	const pending = new Map<string, Promise<T>>();
	return (key, run) => {
		let current = pending.get(key);
		if (!current) {
			current = run().finally(() => pending.delete(key));
			pending.set(key, current);
		}
		return current;
	};
}

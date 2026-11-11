/**
 * Small helpers for text that is built in one place and recognised in
 * another: the start two renderings share, a literal as a pattern, and a
 * value computed once per object. A leaf module.
 */

/** The longest start two texts share. */
export function commonPrefix(a: string, b: string): string {
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return a.slice(0, i);
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `compute` cached per key object: a pattern built from a words object is
 * built once per object (tests that swap the profile get a new one).
 */
export function memoOn<K extends object, V>(compute: (key: K) => V): (key: K) => V {
	const cache = new WeakMap<K, V>();
	return (key) => {
		if (cache.has(key)) return cache.get(key) as V;
		const value = compute(key);
		cache.set(key, value);
		return value;
	};
}

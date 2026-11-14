/**
 * Small helpers for text that is built in one place and recognised in
 * another: a literal as a pattern, and a value computed once per object. A
 * leaf module.
 */

/** Indent every line two spaces, blanks included: Claude Code's hand-back report framing, which a line at column zero cannot forge. */
export function indentReport(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
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

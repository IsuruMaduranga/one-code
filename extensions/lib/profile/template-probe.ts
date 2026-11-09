/**
 * Reading the profile's text back. Where the base must recognise text the
 * profile wrote (a stored line, a wrapped prompt), it renders the profile's
 * template with a marker in the one variable part (the hole) and keeps what
 * lies on either side, so a wording change cannot leave the parser behind.
 * A leaf module: no profile import.
 */

/** The default hole: a character no profile text contains. */
const HOLE = "\u0000";

/** The fixed text a template renders before and after its one variable part. */
export interface Around {
	before: string;
	after: string;
}

/**
 * The text around `hole` in `render(hole)`; undefined when the hole does not
 * appear exactly once (a profile that escapes, repeats or drops it). A
 * numeric hole (`"987654321"`) serves a template whose variable is a number.
 */
export function around(render: (hole: string) => string | undefined, hole = HOLE): Around | undefined {
	const probe = render(hole);
	if (probe === undefined) return undefined;
	const at = probe.indexOf(hole);
	if (at === -1 || probe.includes(hole, at + hole.length)) return undefined;
	return { before: probe.slice(0, at), after: probe.slice(at + hole.length) };
}

/** What `text` holds in the hole when it is the template's rendering, else undefined. */
export function fillOf(text: string, frame: Around | undefined): string | undefined {
	if (!frame || text.length < frame.before.length + frame.after.length) return undefined;
	if (!text.startsWith(frame.before) || !text.endsWith(frame.after)) return undefined;
	return text.slice(frame.before.length, text.length - frame.after.length);
}

/** The longest start two texts share. */
export function commonPrefix(a: string, b: string): string {
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return a.slice(0, i);
}

/** The part of each text between the start and the end they share. */
export function differingSpans(a: string, b: string): [string, string] {
	const head = commonPrefix(a, b).length;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	return [a.slice(head, a.length - tail), b.slice(head, b.length - tail)];
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `compute` cached per key object: a probe built from a profile group is
 * built once per group object (tests that swap the profile get a new one).
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

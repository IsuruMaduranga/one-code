/**
 * The one guard for "a JSON object": not null, not an array. Parsed JSON,
 * tool arguments and request payloads are all checked with it, so every
 * reader agrees on what counts as an object. A leaf module.
 */

/** Whether `value` is a plain object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure key decoding for the subagent panel: the strip's soft-focus keys and the
 * transcript viewer's keys, including the `ctrl+x ctrl+k` stop-all chord. Raw
 * terminal bytes in, intents out — no side effects, fully unit-testable.
 */

const UP = new Set(["\x1b[A", "\x1bOA"]);
const DOWN = new Set(["\x1b[B", "\x1bOB"]);
const RIGHT = new Set(["\x1b[C", "\x1bOC"]);
const LEFT = new Set(["\x1b[D", "\x1bOD"]);

/** Keys the strip responds to while it holds soft focus. */
export type StripKey = "up" | "down" | "open" | "leave";

export function decodeStripKey(data: string): StripKey | undefined {
	if (UP.has(data)) return "up";
	if (DOWN.has(data)) return "down";
	if (data === "\r" || data === "\n") return "open";
	if (data === "\x1b") return "leave";
	return undefined;
}

/** Viewer intents. `stopAll` only ever comes from the completed chord. */
export type ViewerKey =
	| "up"
	| "down"
	| "pageUp"
	| "pageDown"
	| "nextAgent"
	| "prevAgent"
	| "stop"
	| "stopAll"
	| "close";

/**
 * Viewer key decoder with chord state. `ctrl+x` (\x18) arms the chord; a
 * following `ctrl+k` (\x0b) completes it into `stopAll`; any other key cancels
 * the chord and is decoded normally. Returns the decoded key plus the next
 * chord state, so the caller stays stateless.
 */
export function decodeViewerKey(data: string, chordArmed: boolean): { key?: ViewerKey; chordArmed: boolean } {
	if (chordArmed) {
		if (data === "\x0b") return { key: "stopAll", chordArmed: false };
		// Fall through: the chord is cancelled, decode this byte fresh.
	}
	if (data === "\x18") return { chordArmed: true };
	if (UP.has(data)) return { key: "up", chordArmed: false };
	if (DOWN.has(data)) return { key: "down", chordArmed: false };
	if (data === "\x1b[5~") return { key: "pageUp", chordArmed: false };
	if (data === "\x1b[6~") return { key: "pageDown", chordArmed: false };
	if (data === "\t" || RIGHT.has(data)) return { key: "nextAgent", chordArmed: false };
	if (data === "\x1b[Z" || LEFT.has(data)) return { key: "prevAgent", chordArmed: false };
	if (data === "x" || data === "X") return { key: "stop", chordArmed: false };
	if (data === "\x1b" || data === "q" || data === "\x03") return { key: "close", chordArmed: false };
	return { chordArmed: false };
}

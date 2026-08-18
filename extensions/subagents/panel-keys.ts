/**
 * Pure key decoding for the subagent panel strip — Claude Code's agent-tree
 * keys: arrows select (never switch the view), Enter opens/switches the
 * selected agent's transcript, x stops, the `ctrl+x ctrl+k` chord stops all,
 * esc leaves. PageUp/PageDown scroll an open transcript view. Raw terminal
 * bytes in, intents out — no side effects, fully unit-testable.
 */

const UP = new Set(["\x1b[A", "\x1bOA"]);
const DOWN = new Set(["\x1b[B", "\x1bOB"]);

export type StripKey = "up" | "down" | "open" | "leave" | "stop" | "stopAll" | "pageUp" | "pageDown";

/**
 * Decoder with chord state: `ctrl+x` (\x18) arms the chord (consumed, no key);
 * a following `ctrl+k` (\x0b) completes it into `stopAll`; any other key
 * cancels the chord and is decoded normally. A byte that decodes to nothing
 * (typing) is the caller's signal to drop focus and let the byte through.
 */
export function decodeStripKey(data: string, chordArmed: boolean): { key?: StripKey; chordArmed: boolean } {
	if (chordArmed && data === "\x0b") return { key: "stopAll", chordArmed: false };
	if (data === "\x18") return { chordArmed: true };
	if (UP.has(data)) return { key: "up", chordArmed: false };
	if (DOWN.has(data)) return { key: "down", chordArmed: false };
	if (data === "\r" || data === "\n") return { key: "open", chordArmed: false };
	if (data === "\x1b") return { key: "leave", chordArmed: false };
	if (data === "x" || data === "X") return { key: "stop", chordArmed: false };
	if (data === "\x1b[5~") return { key: "pageUp", chordArmed: false };
	if (data === "\x1b[6~") return { key: "pageDown", chordArmed: false };
	return { chordArmed: false };
}

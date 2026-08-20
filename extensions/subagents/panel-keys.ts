/**
 * Pure key decoding for the below-editor panel — Claude Code's agent-tree
 * keys. Their meaning depends on whether a transcript view is open (index.ts
 * owns that split): with no view open, arrows select and Enter opens the
 * selected agent's transcript; while a view IS open the panel is in "read"
 * mode, where arrows scroll it a line at a time, PageUp/PageDown scroll a page,
 * `switch` (Tab) retargets to the next agent, and Enter closes it. `x` stops,
 * the `ctrl+x ctrl+k` chord stops all, esc leaves. `left`/`space` exist for the
 * shell-panel stages (back / close) — the agents branch treats them like
 * typing. Raw terminal bytes in, intents out — no side effects, fully
 * unit-testable.
 */

const UP = new Set(["\x1b[A", "\x1bOA"]);
const DOWN = new Set(["\x1b[B", "\x1bOB"]);
const LEFT = new Set(["\x1b[D", "\x1bOD"]);

export type StripKey = "up" | "down" | "left" | "space" | "switch" | "open" | "leave" | "stop" | "stopAll" | "pageUp" | "pageDown";

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
	if (LEFT.has(data)) return { key: "left", chordArmed: false };
	if (data === "\t") return { key: "switch", chordArmed: false };
	if (data === " ") return { key: "space", chordArmed: false };
	if (data === "\r" || data === "\n") return { key: "open", chordArmed: false };
	if (data === "\x1b") return { key: "leave", chordArmed: false };
	if (data === "x" || data === "X") return { key: "stop", chordArmed: false };
	if (data === "\x1b[5~") return { key: "pageUp", chordArmed: false };
	if (data === "\x1b[6~") return { key: "pageDown", chordArmed: false };
	return { chordArmed: false };
}

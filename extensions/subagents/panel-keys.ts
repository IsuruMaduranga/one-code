/**
 * Pure key decoding for the below-editor panel — Claude Code's agent-tree
 * keys: arrows select, Enter views the selected agent (or `main`), PageUp and
 * PageDown scroll an open view, `x` stops, the `ctrl+x ctrl+k` chord stops
 * all, esc hands focus back to the editor (index.ts owns what each does; an
 * open view stays open while the editor addresses its agent). `left` and
 * `space` serve the shell-panel stages (back, close); the agents branch treats
 * them like typing. Raw terminal bytes in, intents out — no side effects,
 * fully unit-testable. Keys are named through `lib/key-input.ts`, so the
 * legacy, kitty and modifyOtherKeys encodings decode alike, and a kitty key
 * release (sent after every press) is never mistaken for typing.
 */

import { isKeyRelease, keyId, keyText } from "../lib/key-input.ts";

export type StripKey = "up" | "down" | "left" | "space" | "open" | "leave" | "stop" | "stopAll" | "pageUp" | "pageDown";

const STRIP_KEYS: Record<string, StripKey> = {
	up: "up",
	down: "down",
	left: "left",
	space: "space",
	enter: "open",
	escape: "leave",
	pageUp: "pageUp",
	pageDown: "pageDown",
};

/**
 * Decoder with chord state: `ctrl+x` arms the chord (consumed, no key); a
 * following `ctrl+k` completes it into `stopAll`; any other key cancels the
 * chord and is decoded normally. A key release decodes to `release`, which
 * changes nothing (the caller lets it through). Any other chunk that decodes
 * to nothing (typing) is the caller's signal to drop focus and let the byte
 * through.
 */
export function decodeStripKey(data: string, chordArmed: boolean): { key?: StripKey; chordArmed: boolean; release?: true } {
	if (isKeyRelease(data)) return { chordArmed, release: true };
	const id = keyId(data);
	if (chordArmed && id === "ctrl+k") return { key: "stopAll", chordArmed: false };
	if (id === "ctrl+x") return { chordArmed: true };
	const key = id ? STRIP_KEYS[id] : undefined;
	if (key) return { key, chordArmed: false };
	const text = keyText(data);
	if (text === "x" || text === "X") return { key: "stop", chordArmed: false };
	return { chordArmed: false };
}

/** A ↓ press (in any encoding, never its release): the key that enters the strip. */
export function isStripEntryKey(data: string): boolean {
	return !isKeyRelease(data) && keyId(data) === "down";
}

/** The slice of pi's editor the strip reads (structural; every member optional). */
export interface EditorLike {
	getLines?(): string[];
	getCursor?(): { line: number; col: number };
	isShowingAutocomplete?(): boolean;
	/** pi-tui's history position: -1 when no recalled entry is shown. */
	historyIndex?: unknown;
}

/**
 * Whether ↓ belongs to the strip rather than the editor. In a draft the
 * editor needs ↓ to move the cursor down, to walk forward through recalled
 * history, and to move in the autocomplete list, so the strip takes ↓ only
 * with the cursor on the draft's last line, no history entry shown and no
 * autocomplete open (Claude Code's footer rule). An editor without the
 * expected methods keeps the old behaviour (the strip takes ↓).
 */
export function editorYieldsDown(editor: unknown): boolean {
	if (!editor || typeof editor !== "object") return true;
	const e = editor as EditorLike;
	try {
		if (e.isShowingAutocomplete?.()) return false;
		// Read-only use of a private pi-tui field; if a pi bump renames it, the
		// history case falls back to taking ↓ (the behaviour before this check).
		if (typeof e.historyIndex === "number" && e.historyIndex > -1) return false;
		const lines = e.getLines?.();
		const cursor = e.getCursor?.();
		if (!lines || !cursor) return true;
		return cursor.line >= lines.length - 1;
	} catch {
		return true;
	}
}

/**
 * Claude Code's "send now" chord, `ctrl+x ctrl+s` (its `chat:sendNow` action),
 * read from raw terminal input. Pure: the extension feeds it every key.
 *
 * Keys arrive in any of three encodings: the legacy control byte (`\x18`,
 * `\x13`), the kitty keyboard protocol's CSI u form, which pi-tui turns on
 * with flags 7 (disambiguate, event types, alternate keys) where the terminal
 * supports it, or xterm's modifyOtherKeys form (`\x1b[27;5;120~`), which
 * pi-tui turns on otherwise and tmux sends with `extended-keys on`.
 * `lib/key-input.ts` names all three alike. With event types on, a release
 * follows every press, so releases never change the chord's state.
 *
 * pi binds `ctrl+x` alone to "copy the last assistant message". The chord
 * takes a `ctrl+x` only while send now applies (a turn runs with something to
 * send), where it is the chord's prefix as in Claude Code: one the chord does
 * not complete (another key, or the extension's timeout) is dropped. At every
 * other time `ctrl+x` reaches pi and copies.
 */

import { isKeyRelease, keyId } from "../lib/key-input.ts";

export type ChordKey = "ctrl+x" | "ctrl+s" | "release" | "other";

export function classifyKey(data: string): ChordKey {
	if (isKeyRelease(data)) return "release";
	const id = keyId(data);
	if (id === "ctrl+x" || id === "ctrl+s") return id;
	return "other";
}

/**
 * What the extension does with a key: let it through, hold it (a `ctrl+x`
 * that may start the chord, consumed), or send now (the `ctrl+s`, consumed).
 */
export type ChordAction = "pass" | "hold" | "send";

export class SendNowChord {
	private armed = false;

	/** Feed one key; `active` is whether send now applies (a turn is running with something to send). */
	feed(data: string, active: boolean): ChordAction {
		const key = classifyKey(data);
		if (key === "release") return "pass";
		const armed = this.armed;
		this.armed = false;
		// A second ctrl+x, or the kitty protocol's auto-repeat of a held one, keeps the chord armed.
		if (key === "ctrl+x" && active) {
			this.armed = true;
			return "hold";
		}
		if (armed && key === "ctrl+s" && active) return "send";
		return "pass";
	}

	/** The chord timed out: its `ctrl+x` is dropped. */
	expire(): void {
		this.armed = false;
	}
}

/** The hint under the queued messages, Claude Code's wording. */
export const SEND_NOW_HINT = "ctrl+x ctrl+s to send now";

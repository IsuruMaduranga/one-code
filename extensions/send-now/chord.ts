/**
 * Claude Code's "send now" chord, `ctrl+x ctrl+s` (its `chat:sendNow` action),
 * read from raw terminal input. Pure: the extension feeds it every key.
 *
 * Keys arrive in either encoding: the legacy control byte (`\x18`, `\x13`) or
 * the kitty keyboard protocol's CSI u form, which pi-tui turns on with flags 7
 * (disambiguate, event types, alternate keys) where the terminal supports it.
 * With event types on, a release follows every press, so releases and repeats
 * never change the chord's state.
 *
 * pi binds `ctrl+x` alone to "copy the last assistant message". The chord
 * takes a `ctrl+x` only while send now applies (a turn runs with something to
 * send), where it is the chord's prefix as in Claude Code: one the chord does
 * not complete (another key, or the extension's timeout) is dropped. At every
 * other time `ctrl+x` reaches pi and copies.
 */

export type ChordKey = "ctrl+x" | "ctrl+s" | "release" | "other";

const CTRL = 4;
/** Caps lock and num lock bits, which the kitty protocol reports as modifiers. */
const LOCKS = 64 | 128;

export function classifyKey(data: string): ChordKey {
	if (data === "\x18") return "ctrl+x";
	if (data === "\x13") return "ctrl+s";
	const match = data.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?;(\d+)(?::(\d+))?u$/);
	if (!match) return "other";
	if (match[3] === "3") return "release";
	const codepoint = Number(match[1]);
	const modifiers = (Number(match[2]) - 1) & ~LOCKS;
	if (modifiers !== CTRL) return "other";
	if (codepoint === 120) return "ctrl+x";
	if (codepoint === 115) return "ctrl+s";
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

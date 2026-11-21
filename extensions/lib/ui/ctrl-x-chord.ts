/**
 * The `ctrl+x` chord prefix, one for every extension. Claude Code reads
 * `ctrl+x` as the prefix of several chords: `ctrl+x ctrl+s` sends a queued
 * message now (ui/send-now), `ctrl+x ctrl+k` stops the background agents
 * (agents/subagents). Each extension registers its chord's second key with
 * `claimChordKey`, and feeds its terminal input through a `CtrlXPrefix`.
 *
 * pi-tui gives a key to the first input listener that consumes it, so the
 * prefix never belongs to one extension: whichever listener runs first holds
 * `ctrl+x` when any registered chord applies right now (asked over the bus),
 * and offers the next key to all of them. When none applies, `ctrl+x` passes
 * on to pi, which binds it to copy. A held `ctrl+x` that no chord completes
 * (another key, or the timeout) is dropped, and that key passes on.
 */

import { brandedId } from "../profile/brand.mjs";
import { isKeyRelease, keyId } from "./key-input.ts";

export const CTRL_X_CHORD_CHANNEL = brandedId("ctrl-x-chord");

/** How long a held `ctrl+x` waits for its second key. */
export const CHORD_TIMEOUT_MS = 1000;

/** "Does any chord apply now?" (asked on a `ctrl+x`), or a second key offered to the chords. */
type ChordMessage = { kind: "applies"; applies: boolean } | { kind: "key"; key: string; claimed: boolean };

type Emit = { emit(channel: string, data: unknown): void };
type On = { on(channel: string, handler: (data: unknown) => void): () => void };

/**
 * Register a chord: `ctrl+x` then `key` runs `act` while `applies()` holds.
 * Returns the unsubscribe.
 */
export function claimChordKey(events: On, key: string, chord: { applies(): boolean; act(): void }): () => void {
	return events.on(CTRL_X_CHORD_CHANNEL, (data) => {
		const message = data as ChordMessage;
		if (message.kind === "applies") {
			if (!message.applies && chord.applies()) message.applies = true;
		} else if (!message.claimed && message.key === key && chord.applies()) {
			message.claimed = true;
			chord.act();
		}
	});
}

/** One input listener's view of the prefix: feed it every key; it says which to consume. */
export class CtrlXPrefix {
	private armed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly events: Emit,
		private readonly timeoutMs = CHORD_TIMEOUT_MS,
	) {}

	feed(data: string): { consume: true } | undefined {
		if (isKeyRelease(data)) return undefined;
		const id = keyId(data);
		const armed = this.armed;
		this.disarm();
		if (id === "ctrl+x") {
			// A second ctrl+x, or the kitty protocol's auto-repeat of a held one, keeps it held.
			if (!this.ask({ kind: "applies", applies: false })) return undefined;
			this.armed = true;
			this.timer = setTimeout(() => this.disarm(), this.timeoutMs);
			this.timer.unref?.();
			return { consume: true };
		}
		if (!armed || !id) return undefined;
		return this.ask({ kind: "key", key: id, claimed: false }) ? { consume: true } : undefined;
	}

	disarm(): void {
		this.armed = false;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private ask(message: ChordMessage): boolean {
		this.events.emit(CTRL_X_CHORD_CHANNEL, message);
		return message.kind === "applies" ? message.applies : message.claimed;
	}
}

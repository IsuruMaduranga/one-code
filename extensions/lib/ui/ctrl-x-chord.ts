/**
 * The `ctrl+x` chord prefix, shared between extensions. Claude Code reads
 * `ctrl+x` as the prefix of several chords: `ctrl+x ctrl+s` sends a queued
 * message now (ui/send-now), `ctrl+x ctrl+k` stops the background agents
 * (agents/subagents). Each extension holds `ctrl+x` while its own chord
 * applies, but pi-tui gives a key to the first input listener that consumes
 * it, so the other extension never sees the prefix. The one that held it
 * therefore offers a second key that is not its own here, and the extension
 * whose chord that key completes claims it and acts.
 *
 * Pure: no pi imports; the event bus is passed in (jiti isolation, findings §3).
 */

import { brandedId } from "../profile/brand.mjs";

export const CTRL_X_CHORD_CHANNEL = brandedId("ctrl-x-chord");

/** A chord's second key (a key id such as "ctrl+k"), offered after another extension held the `ctrl+x`. */
export interface CtrlXChordOffer {
	key: string;
	claimed: boolean;
}

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Offer `key` to the extension whose chord it completes; true when one claimed it. */
export function offerChordKey(events: Pick<Bus, "emit">, key: string): boolean {
	const offer: CtrlXChordOffer = { key, claimed: false };
	events.emit(CTRL_X_CHORD_CHANNEL, offer);
	return offer.claimed;
}

/** Claim `key` when it is offered and `act` applies (returns true); returns the unsubscribe. */
export function claimChordKey(events: Pick<Bus, "on">, key: string, act: () => boolean): () => void {
	return events.on(CTRL_X_CHORD_CHANNEL, (data) => {
		const offer = data as CtrlXChordOffer;
		if (!offer.claimed && offer.key === key && act()) offer.claimed = true;
	});
}

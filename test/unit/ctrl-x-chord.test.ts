/**
 * lib/ui/ctrl-x-chord.ts: the `ctrl+x` prefix every chord shares (send now's
 * `ctrl+x ctrl+s`, the stop-agents `ctrl+x ctrl+k`). A listener holds
 * `ctrl+x` only while a registered chord applies, and the next key goes to the
 * chord it completes, whichever extension's listener held the prefix.
 */
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHORD_TIMEOUT_MS, claimChordKey, CtrlXPrefix } from "../../extensions/lib/ui/ctrl-x-chord.ts";
import { keyId } from "../../extensions/lib/ui/key-input.ts";

const CONSUME = { consume: true };

/** A bus with send now's and the stop-agents chords registered, and what each did. */
function chords() {
	const events = createEventBus();
	const state = { sendApplies: true, stopApplies: false, sent: 0, stopped: 0 };
	claimChordKey(events, "ctrl+s", { applies: () => state.sendApplies, act: () => state.sent++ });
	claimChordKey(events, "ctrl+k", { applies: () => state.stopApplies, act: () => state.stopped++ });
	return { events, state, prefix: new CtrlXPrefix(events) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the chord keys in every encoding", () => {
	it("names ctrl+x and ctrl+s in the legacy, kitty and modifyOtherKeys forms", () => {
		for (const ctrlX of ["\x18", "\x1b[120;5u", "\x1b[120;69u", "\x1b[120:88;5u", "\x1b[27;5;120~"]) expect(keyId(ctrlX)).toBe("ctrl+x");
		for (const ctrlS of ["\x13", "\x1b[115;5u", "\x1b[115;5:1u", "\x1b[27;5;115~"]) expect(keyId(ctrlS)).toBe("ctrl+s");
		// ctrl+alt+x and ctrl+shift+s are other keys.
		expect(keyId("\x1b[120;7u")).not.toBe("ctrl+x");
		expect(keyId("\x1b[115;6u")).not.toBe("ctrl+s");
	});
});

describe("CtrlXPrefix", () => {
	it("holds ctrl+x while a chord applies and runs the chord its next key completes", () => {
		const { state, prefix } = chords();
		expect(prefix.feed("\x18")).toEqual(CONSUME);
		expect(prefix.feed("\x13")).toEqual(CONSUME);
		expect(state.sent).toBe(1);
		// A ctrl+s on its own is not the chord.
		expect(prefix.feed("\x13")).toBeUndefined();
		expect(state.sent).toBe(1);
	});

	it("gives the second key to whichever chord it completes, the other extension's included", () => {
		const { state, prefix } = chords();
		state.sendApplies = false;
		state.stopApplies = true;
		expect(prefix.feed("\x1b[27;5;120~")).toEqual(CONSUME);
		expect(prefix.feed("\x1b[27;5;107~")).toEqual(CONSUME);
		expect(state.stopped).toBe(1);
	});

	it("ignores key releases and stays held through a repeat of ctrl+x", () => {
		const { state, prefix } = chords();
		expect(prefix.feed("\x1b[120;5u")).toEqual(CONSUME);
		expect(prefix.feed("\x1b[120;5:3u")).toBeUndefined();
		expect(prefix.feed("\x1b[120;5:2u")).toEqual(CONSUME);
		expect(prefix.feed("\x1b[115;5u")).toEqual(CONSUME);
		expect(state.sent).toBe(1);
	});

	it("drops a ctrl+x no chord completes: the next key passes, a later ctrl+s does nothing", () => {
		const { state, prefix } = chords();
		prefix.feed("\x18");
		expect(prefix.feed("a")).toBeUndefined();
		expect(prefix.feed("\x13")).toBeUndefined();
		prefix.feed("\x18");
		vi.advanceTimersByTime(CHORD_TIMEOUT_MS);
		expect(prefix.feed("\x13")).toBeUndefined();
		expect(state.sent).toBe(0);
	});

	it("lets ctrl+x through to pi's copy when no chord applies, and runs nothing whose chord stopped applying", () => {
		const { state, prefix } = chords();
		state.sendApplies = false;
		expect(prefix.feed("\x18")).toBeUndefined();
		state.sendApplies = true;
		prefix.feed("\x18");
		state.sendApplies = false;
		expect(prefix.feed("\x13")).toBeUndefined();
		expect(state.sent).toBe(0);
	});

	it("lets a second listener pass what the first one held: the chord runs once", () => {
		const { events, state, prefix } = chords();
		const second = new CtrlXPrefix(events);
		const feed = (data: string) => prefix.feed(data) ?? second.feed(data);
		expect(feed("\x18")).toEqual(CONSUME);
		expect(feed("\x13")).toEqual(CONSUME);
		expect(state.sent).toBe(1);
	});
});

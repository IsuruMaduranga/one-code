import { describe, expect, it } from "vitest";
import { classifyKey, SendNowChord } from "../../extensions/send-now/chord.ts";

describe("classifyKey", () => {
	it("reads the legacy control bytes", () => {
		expect(classifyKey("\x18")).toBe("ctrl+x");
		expect(classifyKey("\x13")).toBe("ctrl+s");
		expect(classifyKey("x")).toBe("other");
	});

	it("reads the kitty keyboard protocol's CSI u form", () => {
		expect(classifyKey("\x1b[120;5u")).toBe("ctrl+x");
		expect(classifyKey("\x1b[115;5u")).toBe("ctrl+s");
		expect(classifyKey("\x1b[115;5:1u")).toBe("ctrl+s");
		expect(classifyKey("\x1b[115;5:2u")).toBe("ctrl+s");
		// Caps lock on still counts as plain ctrl.
		expect(classifyKey("\x1b[120;69u")).toBe("ctrl+x");
		// Alternate-key fields (flag 4) before the modifiers.
		expect(classifyKey("\x1b[120:88;5u")).toBe("ctrl+x");
	});

	it("tells releases and other modifiers apart", () => {
		expect(classifyKey("\x1b[120;5:3u")).toBe("release");
		expect(classifyKey("\x1b[120;7u")).toBe("other"); // ctrl+alt+x
		expect(classifyKey("\x1b[115;6u")).toBe("other"); // ctrl+shift+s
		expect(classifyKey("\x1b[13;5u")).toBe("other"); // ctrl+enter
	});
});

describe("SendNowChord", () => {
	it("holds ctrl+x while active and sends on the ctrl+s that follows", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x18", true)).toBe("hold");
		expect(chord.feed("\x13", true)).toBe("send");
		expect(chord.feed("\x13", true)).toBe("pass");
	});

	it("ignores the release that follows each press", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x1b[120;5u", true)).toBe("hold");
		expect(chord.feed("\x1b[120;5:3u", true)).toBe("pass");
		expect(chord.feed("\x1b[115;5u", true)).toBe("send");
	});

	it("stays armed through a repeat of the held ctrl+x", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x1b[120;5u", true)).toBe("hold");
		expect(chord.feed("\x1b[120;5:2u", true)).toBe("hold");
		expect(chord.feed("\x1b[115;5u", true)).toBe("send");
	});

	it("drops an unfinished chord: the next key passes, a later ctrl+s does not send", () => {
		const chord = new SendNowChord();
		chord.feed("\x1b[120;5u", true);
		expect(chord.feed("a", true)).toBe("pass");
		expect(chord.feed("\x13", true)).toBe("pass");
	});

	it("drops it on timeout", () => {
		const chord = new SendNowChord();
		chord.feed("\x18", true);
		chord.expire();
		expect(chord.feed("\x13", true)).toBe("pass");
	});

	it("lets ctrl+x through to pi's copy when there is nothing to send", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x18", false)).toBe("pass");
		expect(chord.feed("\x13", false)).toBe("pass");
		chord.feed("\x18", true);
		expect(chord.feed("\x13", false)).toBe("pass");
	});
});

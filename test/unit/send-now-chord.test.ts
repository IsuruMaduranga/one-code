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
		expect(chord.feed("\x18", true)).toEqual({ kind: "hold" });
		expect(chord.feed("\x13", true)).toEqual({ kind: "send" });
		expect(chord.feed("\x13", true)).toEqual({ kind: "pass" });
	});

	it("ignores the release that follows each press", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x1b[120;5u", true)).toEqual({ kind: "hold" });
		expect(chord.feed("\x1b[120;5:3u", true)).toEqual({ kind: "pass" });
		expect(chord.feed("\x1b[115;5u", true)).toEqual({ kind: "send" });
	});

	it("stays armed through a repeat of the held ctrl+x", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x1b[120;5u", true)).toEqual({ kind: "hold" });
		expect(chord.feed("\x1b[120;5:2u", true)).toEqual({ kind: "hold" });
		expect(chord.feed("\x1b[115;5u", true)).toEqual({ kind: "send" });
	});

	it("hands the held ctrl+x back ahead of any other key", () => {
		const chord = new SendNowChord();
		chord.feed("\x1b[120;5u", true);
		expect(chord.feed("a", true)).toEqual({ kind: "replay", held: "\x1b[120;5u" });
		expect(chord.feed("\x13", true)).toEqual({ kind: "pass" });
	});

	it("hands it back when the chord times out", () => {
		const chord = new SendNowChord();
		chord.feed("\x18", true);
		expect(chord.expire()).toBe("\x18");
		expect(chord.expire()).toBeUndefined();
		expect(chord.feed("\x13", true)).toEqual({ kind: "pass" });
	});

	it("lets ctrl+x through untouched when there is nothing to send", () => {
		const chord = new SendNowChord();
		expect(chord.feed("\x18", false)).toEqual({ kind: "pass" });
		expect(chord.feed("\x13", false)).toEqual({ kind: "pass" });
		chord.feed("\x18", true);
		expect(chord.feed("\x13", false)).toEqual({ kind: "replay", held: "\x18" });
	});
});

/**
 * agents/subagents/stop-all.ts and lib/ui/ctrl-x-chord.ts: Claude Code's
 * `ctrl+x ctrl+k` from the prompt (two presses within three seconds), the
 * strip's hint and prompt, and the hand-off of a chord's second key between
 * the extensions that share the `ctrl+x` prefix.
 */
import { describe, expect, it } from "vitest";
import { PromptChord, STOP_ALL_CONFIRM, STOP_ALL_CONFIRM_MS, STOP_ALL_HINT, StopAllPresses, stopAllNote } from "../../extensions/agents/subagents/stop-all.ts";
import { claimChordKey, offerChordKey } from "../../extensions/lib/ui/ctrl-x-chord.ts";
import { renderStrip } from "../../extensions/agents/subagents/panel-render.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";

const CTRL_X = "\x18";
const CTRL_K = "\x0b";

describe("PromptChord", () => {
	it("holds ctrl+x only while an agent runs, and counts the ctrl+k after it", () => {
		const chord = new PromptChord();
		expect(chord.feed(CTRL_X, false)).toBe("pass");
		expect(chord.feed(CTRL_K, false)).toBe("pass");
		expect(chord.feed(CTRL_X, true)).toBe("hold");
		expect(chord.feed(CTRL_K, true)).toBe("stopAll");
		expect(chord.feed(CTRL_K, true)).toBe("pass");
	});

	it("reads the kitty and modifyOtherKeys forms, and ignores key releases", () => {
		const chord = new PromptChord();
		expect(chord.feed("\x1b[120;5u", true)).toBe("hold");
		expect(chord.feed("\x1b[120;5:3u", true)).toBe("pass");
		expect(chord.feed("\x1b[27;5;107~", true)).toBe("stopAll");
	});

	it("offers any other key after a held ctrl+x, and forgets a ctrl+x that timed out", () => {
		const chord = new PromptChord();
		chord.feed(CTRL_X, true);
		expect(chord.feed("\x13", true)).toBe("offer");
		chord.feed(CTRL_X, true);
		chord.expire();
		expect(chord.feed(CTRL_K, true)).toBe("pass");
	});
});

describe("StopAllPresses", () => {
	it("asks on the first press and stops on a second inside three seconds", () => {
		const presses = new StopAllPresses();
		expect(presses.press(1000)).toBe("confirm");
		expect(presses.asking(1000 + STOP_ALL_CONFIRM_MS)).toBe(true);
		expect(presses.press(1000 + STOP_ALL_CONFIRM_MS)).toBe("stop");
		expect(presses.asking(1000 + STOP_ALL_CONFIRM_MS)).toBe(false);
	});

	it("asks again once the window has passed", () => {
		const presses = new StopAllPresses();
		presses.press(0);
		expect(presses.asking(STOP_ALL_CONFIRM_MS + 1)).toBe(false);
		expect(presses.press(STOP_ALL_CONFIRM_MS + 1)).toBe("confirm");
	});
});

describe("the strip's stop-all note", () => {
	it("shows the hint while agents run, the prompt after a first press, and nothing when none runs", () => {
		expect(stopAllNote(false, true)).toBe(STOP_ALL_HINT);
		expect(stopAllNote(true, true)).toBe(STOP_ALL_CONFIRM);
		expect(stopAllNote(true, false)).toBeUndefined();
		// A focused strip names the key in its own hint line.
		expect(stopAllNote(false, true, true)).toBeUndefined();
		expect(stopAllNote(true, true, true)).toBe(STOP_ALL_CONFIRM);
		expect(STOP_ALL_HINT).toBe("ctrl+x ctrl+k to stop agents");
		expect(STOP_ALL_CONFIRM).toBe("Press ctrl+x ctrl+k again to stop background agents");
	});

	it("sits on the right of the main row", () => {
		const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const rows = [{ label: "main", status: "idle", activity: "", depth: 0, startedAt: 0, tokens: 0 }] as never;
		const [main] = renderStrip({ rows, width: 80, now: 0, mainNote: STOP_ALL_HINT }, plain);
		expect(main).toMatch(/main\s+ctrl\+x ctrl\+k to stop agents$/);
	});
});

describe("the ctrl+x chord hand-off", () => {
	it("gives an offered key to the extension whose chord it completes, when that chord applies", () => {
		const events = createEventBus();
		let applies = false;
		let stops = 0;
		claimChordKey(events, "ctrl+k", () => {
			if (!applies) return false;
			stops++;
			return true;
		});
		expect(offerChordKey(events, "ctrl+k")).toBe(false);
		applies = true;
		expect(offerChordKey(events, "ctrl+s")).toBe(false);
		expect(offerChordKey(events, "ctrl+k")).toBe(true);
		expect(stops).toBe(1);
	});
});

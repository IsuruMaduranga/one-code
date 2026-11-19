/**
 * agents/subagents/stop-all.ts: Claude Code's `ctrl+x ctrl+k` takes two
 * presses within three seconds, and the strip shows its hint and prompt. The
 * chord itself rides the shared prefix (ctrl-x-chord.test.ts).
 */
import { describe, expect, it } from "vitest";
import { STOP_ALL_CONFIRM, STOP_ALL_CONFIRM_MS, STOP_ALL_HINT, StopAllPresses, stopAllNote } from "../../extensions/agents/subagents/stop-all.ts";
import { renderStrip } from "../../extensions/agents/subagents/panel-render.ts";

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
		expect(stopAllNote(false, true, false)).toBe(STOP_ALL_HINT);
		expect(stopAllNote(true, true, false)).toBe(STOP_ALL_CONFIRM);
		expect(stopAllNote(true, false, false)).toBeUndefined();
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

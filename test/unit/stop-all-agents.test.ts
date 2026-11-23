/**
 * agents/subagents/stop-all.ts: Claude Code's `ctrl+x ctrl+k` takes two
 * presses within three seconds, and the strip shows its hint and prompt. The
 * chord itself rides the shared prefix (ctrl-x-chord.test.ts).
 */
import { describe, expect, it } from "vitest";
import { STOP_ALL_CONFIRM, STOP_ALL_CONFIRM_MS, STOP_ALL_HINT, StopAllPresses, stopAllNote } from "../../extensions/agents/subagents/stop-all.ts";
import { buildRows, renderStrip, stripHint } from "../../extensions/agents/subagents/panel-render.ts";
import { LiveRunRegistry } from "../../extensions/agents/subagents/live-runs.ts";
import { plainTheme } from "./helpers/plain-theme.ts";

describe("StopAllPresses", () => {
	it("asks on the first press and stops on a second inside three seconds", () => {
		const presses = new StopAllPresses();
		expect(presses.press(1000, ["a"])).toBe("confirm");
		expect(presses.asking(1000 + STOP_ALL_CONFIRM_MS, ["a"])).toBe(true);
		expect(presses.press(1000 + STOP_ALL_CONFIRM_MS, ["a"])).toBe("stop");
		expect(presses.asking(1000 + STOP_ALL_CONFIRM_MS, ["a"])).toBe(false);
	});

	it("asks again once the window has passed", () => {
		const presses = new StopAllPresses();
		presses.press(0, ["a"]);
		expect(presses.asking(STOP_ALL_CONFIRM_MS + 1, ["a"])).toBe(false);
		expect(presses.press(STOP_ALL_CONFIRM_MS + 1, ["a"])).toBe("confirm");
	});

	// The question is about the agents running when it was asked.
	it("asks again for an agent that started after the first press", () => {
		const presses = new StopAllPresses();
		presses.press(0, ["a"]);
		// "a" finished and "b" started inside the window.
		expect(presses.asking(1000, ["b"])).toBe(false);
		expect(presses.press(1000, ["b"])).toBe("confirm");
		expect(presses.press(2000, ["b"])).toBe("stop");
	});

	it("drops the question when every agent it asked about has finished", () => {
		const presses = new StopAllPresses();
		presses.press(0, ["a", "b"]);
		expect(presses.asking(500, [])).toBe(false);
		// One of the asked agents still running: the question stands for it.
		expect(presses.press(1000, ["b"])).toBe("stop");
	});
});

describe("the focused strip's stop-all hint", () => {
	const reg = new LiveRunRegistry();
	reg.register({ taskId: "nested", name: "helper", description: "helper", agentType: "general-purpose", task: "t", startedAt: 0, depth: 1, parentTaskId: "p" });
	const rows = buildRows(reg.list(), false);

	it("names the chord only while it would act, not for any running row", () => {
		// A running row the chord does not stop (a nested run, an agent still starting).
		expect(rows.some((row) => row.run?.status === "running")).toBe(true);
		expect(stripHint(rows, 0, undefined, false)).not.toContain("ctrl+x ctrl+k");
		expect(stripHint(rows, 0, undefined, true)).toContain("ctrl+x ctrl+k stop all");
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
		const plain = plainTheme;
		const rows = [{ label: "main", status: "idle", activity: "", depth: 0, startedAt: 0, tokens: 0 }] as never;
		const [main] = renderStrip({ rows, width: 80, now: 0, mainNote: STOP_ALL_HINT }, plain);
		expect(main).toMatch(/main\s+ctrl\+x ctrl\+k to stop agents$/);
	});
});

import { describe, expect, it } from "vitest";
import {
	buildDynamicLoopPrompt,
	buildLoopMessage,
	clampDelaySeconds,
	MAX_DELAY_SECONDS,
	MIN_DELAY_SECONDS,
	parseLoopArgs,
} from "../../extensions/background/wakeup.ts";

describe("clampDelaySeconds", () => {
	it("clamps to [60, 3600] and rounds", () => {
		expect(clampDelaySeconds(30)).toBe(MIN_DELAY_SECONDS);
		expect(clampDelaySeconds(99999)).toBe(MAX_DELAY_SECONDS);
		expect(clampDelaySeconds(300.4)).toBe(300);
		expect(clampDelaySeconds(Number.NaN)).toBe(MIN_DELAY_SECONDS);
	});
});

describe("parseLoopArgs", () => {
	it("reads a leading duration token as the interval and the rest as the task", () => {
		expect(parseLoopArgs("5m check the build")).toEqual({ intervalSeconds: 300, task: "check the build" });
		expect(parseLoopArgs("30s poll ci")).toEqual({ intervalSeconds: 30, task: "poll ci" });
		expect(parseLoopArgs("2h nightly sweep")).toEqual({ intervalSeconds: 7200, task: "nightly sweep" });
	});

	it("treats no leading duration as dynamic (self-paced) mode", () => {
		expect(parseLoopArgs("watch the deploy and report changes")).toEqual({
			task: "watch the deploy and report changes",
		});
		// A number that isn't a duration token stays part of the task.
		expect(parseLoopArgs("check 5 open PRs")).toEqual({ task: "check 5 open PRs" });
	});

	it("trims surrounding whitespace", () => {
		expect(parseLoopArgs("  10m   do the thing  ")).toEqual({ intervalSeconds: 600, task: "do the thing" });
	});
});

describe("loop messages", () => {
	it("frames both loop openers as system notifications carrying the task", () => {
		const task = "run the smoke tests";
		for (const msg of [buildLoopMessage(task), buildDynamicLoopPrompt(task)]) {
			expect(msg).toContain("NOT USER INPUT"); // anti-confabulation framing
			expect(msg).toContain(task);
		}
	});

	it("the dynamic opener tells the model to drive schedule_wakeup", () => {
		const msg = buildDynamicLoopPrompt("do it");
		expect(msg).toContain("schedule_wakeup");
		expect(msg).toContain("stop: true");
	});
});

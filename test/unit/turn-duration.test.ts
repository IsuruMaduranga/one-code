import { describe, expect, it } from "vitest";
import { turnDurationText } from "../../extensions/turn-duration/line.ts";
import { pickCompletionVerb, TURN_COMPLETION_VERBS } from "../../extensions/turn-duration/verbs.ts";

describe("turn-duration verbs", () => {
	it("has Claude Code's eight completion verbs", () => {
		expect(TURN_COMPLETION_VERBS).toEqual([
			"Baked",
			"Brewed",
			"Churned",
			"Cogitated",
			"Cooked",
			"Crunched",
			"Sautéed",
			"Worked",
		]);
	});

	it("maps the RNG across the list, clamping the 1.0 edge to the last verb", () => {
		expect(pickCompletionVerb(() => 0)).toBe("Baked");
		expect(pickCompletionVerb(() => 0.999)).toBe("Worked");
		expect(pickCompletionVerb(() => 1)).toBe("Worked");
		expect(pickCompletionVerb(() => 0.5)).toBe("Cooked");
	});
});

describe("turnDurationText", () => {
	it("renders seconds under a minute", () => {
		expect(turnDurationText("Cooked", 12_000)).toBe("Cooked for 12s");
	});

	it("renders minutes and seconds", () => {
		expect(turnDurationText("Cooked", 5 * 60_000 + 12_000)).toBe("Cooked for 5m 12s");
	});

	it("renders hours and minutes", () => {
		expect(turnDurationText("Worked", 60 * 60_000 + 6 * 60_000)).toBe("Worked for 1h 6m");
	});

	it("appends the background-shell tail while shells outlive the turn", () => {
		expect(turnDurationText("Worked", 7_000, 2)).toBe("Worked for 7s · 2 shells still running");
		expect(turnDurationText("Worked", 7_000, 1)).toBe("Worked for 7s · 1 shell still running");
		expect(turnDurationText("Worked", 7_000, 0)).toBe("Worked for 7s");
	});

	it("rounds sub-second turns to 0s (CC has no minimum threshold)", () => {
		expect(turnDurationText("Brewed", 400)).toBe("Brewed for 0s");
	});
});

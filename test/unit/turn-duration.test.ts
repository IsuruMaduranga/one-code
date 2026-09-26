import { describe, expect, it } from "vitest";
import { formatDoneAt, timeLocale, turnDurationText } from "../../extensions/turn-duration/line.ts";
import { TurnSpan } from "../../extensions/turn-duration/span.ts";
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

const RAN = [{ role: "assistant", stopReason: "stop" }];
const FAILED = [{ role: "assistant", stopReason: "error" }];
const ABORTED = [{ role: "assistant", stopReason: "aborted" }];

describe("TurnSpan", () => {
	it("measures one plain run from start to settle", () => {
		const span = new TurnSpan();
		span.runStarted(1_000);
		span.runEnded(RAN);
		expect(span.settle(4_000)).toBe(3_000);
	});

	it("spans a retried turn from the FIRST run, so the line reports the real wait", () => {
		const span = new TurnSpan();
		span.runStarted(1_000);
		span.runEnded(FAILED); // provider overloaded; pi retries
		span.runStarted(3_000); // retry, same user turn
		span.runEnded(RAN);
		expect(span.settle(10_000)).toBe(9_000);
	});

	// Non-zero starts on purpose: with a 0 start these would pass even if the
	// outcome gate broke, because the span would read as never opened.
	it("renders nothing for a turn that ends errored or aborted", () => {
		const errored = new TurnSpan();
		errored.runStarted(1_000);
		errored.runEnded(FAILED);
		expect(errored.settle(5_000)).toBeUndefined();

		const aborted = new TurnSpan();
		aborted.runStarted(1_000);
		aborted.runEnded(ABORTED);
		expect(aborted.settle(5_000)).toBeUndefined();
	});

	it("renders nothing when settle arrives without a run", () => {
		expect(new TurnSpan().settle(5_000)).toBeUndefined();

		// A run that started but never ended is not a finished turn either.
		const started = new TurnSpan();
		started.runStarted(1_000);
		expect(started.settle(5_000)).toBeUndefined();
	});

	it("treats a start of 0 as a real start, and keeps it across a retry", () => {
		const span = new TurnSpan();
		span.runStarted(0);
		span.runEnded(FAILED);
		span.runStarted(2_000);
		span.runEnded(RAN);
		expect(span.settle(6_000)).toBe(6_000);
	});

	it("resets between turns, so a failed turn does not mute or stretch the next one", () => {
		const span = new TurnSpan();
		span.runStarted(1_000);
		span.runEnded(FAILED);
		expect(span.settle(2_000)).toBeUndefined();

		span.runStarted(8_000);
		span.runEnded(RAN);
		expect(span.settle(9_500)).toBe(1_500);
	});
});

describe("turnDurationText with a done time", () => {
	it("puts done before the shells tail, as Claude Code does", () => {
		expect(turnDurationText("Churned", 6 * 60_000 + 59_000, 1, "2:33 PM")).toBe("Churned for 6m 59s · done 2:33 PM · 1 shell still running");
		expect(turnDurationText("Cooked", 12_000, 0, "2:33 PM")).toBe("Cooked for 12s · done 2:33 PM");
		expect(turnDurationText("Cooked", 12_000, 0, "")).toBe("Cooked for 12s");
	});
});

describe("formatDoneAt", () => {
	// Intl puts a narrow no-break space before AM/PM on current ICU.
	const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");
	const now = new Date(2026, 8, 26, 18, 0);

	it("shows the time alone for today", () => {
		expect(plain(formatDoneAt(new Date(2026, 8, 26, 14, 33), now, "en-US"))).toBe("2:33 PM");
	});

	it("adds the weekday within the last week", () => {
		expect(plain(formatDoneAt(new Date(2026, 8, 25, 9, 5), now, "en-US"))).toBe("Friday 9:05 AM");
	});

	it("adds the date before that", () => {
		expect(plain(formatDoneAt(new Date(2026, 8, 12, 14, 33), now, "en-US"))).toBe("Saturday, Sep 12, 2:33 PM");
	});

	it("uses the locale's hour cycle", () => {
		expect(formatDoneAt(new Date(2026, 8, 26, 14, 33), now, "en-GB")).toBe("14:33");
	});

	it("is empty for an invalid date", () => {
		expect(formatDoneAt(new Date("nope"), now, "en-US")).toBe("");
	});
});

describe("timeLocale", () => {
	it("reads LC_ALL, then LC_TIME, then LANG, as Claude Code does", () => {
		expect(timeLocale({ LANG: "en_US.UTF-8" })).toBe("en-US");
		expect(timeLocale({ LC_TIME: "de_DE.UTF-8", LANG: "en_US.UTF-8" })).toBe("de-DE");
		expect(timeLocale({ LC_ALL: "fr_FR@euro", LC_TIME: "de_DE" })).toBe("fr-FR");
	});

	it("leaves the default for C, POSIX or nothing", () => {
		expect(timeLocale({ LANG: "C" })).toBeUndefined();
		expect(timeLocale({ LANG: "POSIX" })).toBeUndefined();
		expect(timeLocale({})).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { nextPrPollDelay, parsePrNumber, PR_IDLE_STOP_MS, PR_POLL_INTERVAL_MS } from "../../extensions/footer/pr.ts";

describe("parsePrNumber", () => {
	it("returns the first PR number from gh pr list --json output", () => {
		expect(parsePrNumber('[{"number":1574}]')).toBe(1574);
		// A fork PR is still just a number in the list — isCrossRepository is why
		// `gh pr view <branch>` missed it, but list --head finds it.
		expect(parsePrNumber('[{"number":1574,"isCrossRepository":true}]')).toBe(1574);
		expect(parsePrNumber('[{"number":42},{"number":43}]')).toBe(42);
	});

	it("returns undefined for an empty list (no open PR for the branch)", () => {
		expect(parsePrNumber("[]")).toBeUndefined();
	});

	it("returns undefined for malformed, non-array, or non-numeric output", () => {
		expect(parsePrNumber("not json")).toBeUndefined();
		expect(parsePrNumber("")).toBeUndefined();
		expect(parsePrNumber('{"number":7}')).toBeUndefined(); // object, not the list shape
		expect(parsePrNumber('[{"number":"7"}]')).toBeUndefined();
		expect(parsePrNumber("[{}]")).toBeUndefined();
	});
});

describe("nextPrPollDelay", () => {
	const now = 10_000_000;

	it("waits a minute from the last lookup, never less", () => {
		expect(nextPrPollDelay({ lastLookupAt: now, lastInputAt: now, disabled: false }, now)).toBe(PR_POLL_INTERVAL_MS);
		expect(nextPrPollDelay({ lastLookupAt: now - 45_000, lastInputAt: now, disabled: false }, now)).toBe(15_000);
		expect(nextPrPollDelay({ lastLookupAt: now - 5 * 60_000, lastInputAt: now, disabled: false }, now)).toBe(0);
	});

	it("stops after an hour without input", () => {
		expect(nextPrPollDelay({ lastLookupAt: now, lastInputAt: now - PR_IDLE_STOP_MS, disabled: false }, now)).toBeUndefined();
		expect(nextPrPollDelay({ lastLookupAt: now, lastInputAt: now - PR_IDLE_STOP_MS + 1, disabled: false }, now)).toBe(PR_POLL_INTERVAL_MS);
	});

	it("stays off once a slow or missing gh turned it off", () => {
		expect(nextPrPollDelay({ lastLookupAt: 0, lastInputAt: now, disabled: true }, now)).toBeUndefined();
	});
});

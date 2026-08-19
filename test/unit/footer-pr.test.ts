import { describe, expect, it } from "vitest";
import { parsePrNumber } from "../../extensions/footer/pr.ts";

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

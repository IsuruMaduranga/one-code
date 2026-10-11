import { describe, expect, it } from "vitest";
import { extendingCompletions } from "../../extensions/lib/argument-hints.ts";

describe("extendingCompletions", () => {
	it("offers only values longer than what was typed, and closes the menu on an exact match", () => {
		const options = [
			{ value: "presets", label: "presets" },
			{ value: "preset quality", label: "preset quality" },
			{ value: "report", label: "report" },
		];
		expect(extendingCompletions("pre", options)?.map((o) => o.value)).toEqual(["presets", "preset quality"]);
		expect(extendingCompletions("report", options)).toBeNull();
		expect(extendingCompletions("REPORT ", options)).toBeNull();
		expect(extendingCompletions("", options)).toHaveLength(3);
	});
});

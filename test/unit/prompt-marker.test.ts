import { describe, expect, it } from "vitest";
import { applyPromptMarker } from "../../extensions/branding/prompt-marker.ts";

const MARK = "\x1b[38;5;209m›\x1b[0m "; // colored chevron + space, 2 visible cols

describe("applyPromptMarker", () => {
	it("replaces only the first content line's gutter, leaving the border and text", () => {
		const lines = ["────────", "  hello", "  world", "────────"];
		const out = applyPromptMarker(lines, 2, MARK);
		expect(out[0]).toBe("────────"); // top border untouched
		expect(out[1]).toBe(`${MARK}hello`); // gutter → marker, text intact
		expect(out[2]).toBe("  world"); // continuation line keeps plain gutter
		expect(out[3]).toBe("────────");
	});

	it("does not mutate the input array", () => {
		const lines = ["──", "  x", "──"];
		applyPromptMarker(lines, 2, MARK);
		expect(lines[1]).toBe("  x");
	});

	it("is a no-op when there is no content line", () => {
		expect(applyPromptMarker(["──"], 2, MARK)).toEqual(["──"]);
	});

	it("is a no-op when the first gutter is not blank padding (unexpected shape)", () => {
		const lines = ["──", "XYtext", "──"]; // no leading spaces where padding is expected
		expect(applyPromptMarker(lines, 2, MARK)).toEqual(lines);
	});

	it("is a no-op when padding is zero", () => {
		const lines = ["──", "text", "──"];
		expect(applyPromptMarker(lines, 0, MARK)).toEqual(lines);
	});
});

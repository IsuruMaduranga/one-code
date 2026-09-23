import { describe, expect, it } from "vitest";
import { applyArgumentHint, hintForInput } from "../../extensions/lib/argument-hints.ts";

describe("hintForInput", () => {
	const hints = new Map([["btw", "[question]"]]);

	it("hints a bare command, one space after the cursor, or right after it once a space is typed", () => {
		expect(hintForInput("/btw", hints)).toBe(" [question]");
		expect(hintForInput("/btw ", hints)).toBe("[question]");
	});

	it("stops once the argument is typed, and ignores unhinted or partial commands", () => {
		expect(hintForInput("/btw why", hints)).toBeUndefined();
		expect(hintForInput("/btw  ", hints)).toBeUndefined();
		expect(hintForInput("/bt", hints)).toBeUndefined();
		expect(hintForInput("/help", hints)).toBeUndefined();
		expect(hintForInput("btw", hints)).toBeUndefined();
	});
});

describe("applyArgumentHint", () => {
	const cursor = "\x1b[7m \x1b[0m";
	const border = "─".repeat(20);

	it("draws the placeholder into the padding after the end cursor, keeping the width", () => {
		const lines = [border, `  /btw${cursor}${" ".repeat(13)}`, border];
		const out = applyArgumentHint(lines, " [question]");
		expect(out[1]).toBe(`  /btw${cursor} [question]${" ".repeat(2)}`);
		expect(out[0]).toBe(border);
	});

	it("leaves the lines alone without an end cursor or room for the placeholder", () => {
		const noCursor = [border, "  /btw              ", border];
		expect(applyArgumentHint(noCursor, " [question]")).toBe(noCursor);
		const tight = [border, `  /btw${cursor}  `, border];
		expect(applyArgumentHint(tight, " [question]")).toBe(tight);
	});
});

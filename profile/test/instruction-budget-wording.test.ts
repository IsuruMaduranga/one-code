/**
 * One Code's note in a skipped instruction file's slot: its size, the window,
 * the files a section inlines, and to read what it needs. When the base skips
 * a file: test/unit/instruction-budget.test.ts.
 */
import { describe, expect, it } from "vitest";
import { skippedInstructionNote } from "../../extensions/lib/instruction-budget.ts";

describe("One Code's skipped-instruction note", () => {
	it("tells the model the size, the window, the files a section inlines, and to read what it needs", () => {
		expect(skippedInstructionNote(210_000, 200_000)).toBe(
			"This file is not loaded: it is about 210,000 tokens, and instruction files may take at most half of this model's 200,000-token context window. " +
				"Read the parts of it that bear on your task when you need them.\n",
		);
		expect(skippedInstructionNote(210_000, 200_000, ["/p/big.md"])).toMatch(/^This file and the files it imports \(\/p\/big\.md\) are not loaded: together they are about 210,000 tokens/);
	});
});

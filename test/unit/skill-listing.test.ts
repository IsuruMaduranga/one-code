import { describe, expect, it } from "vitest";
import { skillListingText } from "../../extensions/skill/listing.ts";

describe("skillListingText (C4)", () => {
	it("carries a multi-line description whole, so the 'Use when' trigger survives", () => {
		const description = "Drive the MI language server manually over LSP.\nUse when validating LS changes end-to-end against a real running server.";
		const text = skillListingText([{ name: "verify-ls", description, state: "on" }]);
		expect(text).toBe(`- verify-ls: ${description}`);
		expect(text).toContain("Use when validating LS changes");
	});

	it("honours the per-skill state", () => {
		const text = skillListingText([
			{ name: "a", description: "A does things", state: "on" },
			{ name: "b", description: "hidden from the model's eyes", state: "name-only" },
			{ name: "c", description: "never listed", state: "user-only" },
			{ name: "d", description: "never listed", state: "off" },
		]);
		expect(text).toBe("- a: A does things\n- b");
	});

	it("says so when nothing is available", () => {
		expect(skillListingText([])).toBe("(no skills available)");
		expect(skillListingText([{ name: "x", state: "off" }])).toBe("(no skills available)");
	});
});

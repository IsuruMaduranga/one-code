import { describe, expect, it } from "vitest";
import {
	type ListedSkill,
	listingDescription,
	SKILL_DESCRIPTION_CAP,
	skillListingBudget,
	skillListingText,
	usageScore,
} from "../../extensions/skill/listing.ts";

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

describe("skillListingText: Claude Code's line, clip and budget", () => {
	it("appends when_to_use after ' - '", () => {
		expect(skillListingText([{ name: "loop", description: "Run a prompt.", whenToUse: "When the user wants a recurring task.", state: "on" }])).toBe(
			"- loop: Run a prompt. - When the user wants a recurring task.",
		);
	});

	it("clips an entry's text to 1,535 characters and an ellipsis", () => {
		const long = "x".repeat(2219);
		const line = skillListingText([{ name: "kit", description: long, state: "on" }]);
		expect(line).toBe(`- kit: ${"x".repeat(1535)}…`);
		expect(listingDescription({ description: long })).toHaveLength(SKILL_DESCRIPTION_CAP);
		expect(listingDescription({ description: "x".repeat(SKILL_DESCRIPTION_CAP) })).toBe("x".repeat(SKILL_DESCRIPTION_CAP));
		// The cap applies to the description and when_to_use together.
		expect(listingDescription({ description: "x".repeat(1530), whenToUse: "use it often" })).toBe(`${"x".repeat(1530)} - us…`);
	});

	it("budgets 1% of the context window at 4 characters per token, 200K when unknown, the env variable replacing it", () => {
		expect(skillListingBudget(200_000, {})).toBe(8_000);
		expect(skillListingBudget(1_000_000, {})).toBe(40_000);
		expect(skillListingBudget(undefined, {})).toBe(8_000);
		expect(skillListingBudget(200_000, { SLASH_COMMAND_TOOL_CHAR_BUDGET: "123" })).toBe(123);
		expect(skillListingBudget(200_000, { SLASH_COMMAND_TOOL_CHAR_BUDGET: "nope" })).toBe(8_000);
	});

	it("over budget, keeps bundled and name-only lines, then the most used, and names the rest", () => {
		const skills: ListedSkill[] = [
			{ name: "rare", description: "r".repeat(40), state: "on", usage: 0 },
			{ name: "often", description: "o".repeat(40), state: "on", usage: 5 },
			{ name: "plain", description: "p".repeat(40), state: "name-only" },
			{ name: "review", description: "b".repeat(40), state: "on", bundled: true },
		];
		const whole = skillListingText(skills);
		expect(skillListingText(skills, whole.length)).toBe(whole);
		// Room for one more description beyond the kept lines: the most used gets it.
		const kept = ["- rare", `- often: ${"o".repeat(40)}`, "- plain", `- review: ${"b".repeat(40)}`].join("\n");
		expect(skillListingText(skills, kept.length + 5)).toBe(kept);
		// No room at all: bundled and name-only lines stay whole, the others go to names.
		expect(skillListingText(skills, 10)).toBe(["- rare", "- often", "- plain", `- review: ${"b".repeat(40)}`].join("\n"));
	});

	it("scores usage as uses halved weekly, floored at a tenth", () => {
		const now = new Date("2026-10-04T00:00:00Z");
		expect(usageScore(undefined, now)).toBe(0);
		expect(usageScore({ count: 4, lastUsedAt: now.toISOString() }, now)).toBe(4);
		expect(usageScore({ count: 4, lastUsedAt: "2026-09-27T00:00:00Z" }, now)).toBe(2);
		expect(usageScore({ count: 10, lastUsedAt: "2025-01-01T00:00:00Z" }, now)).toBe(1);
	});
});

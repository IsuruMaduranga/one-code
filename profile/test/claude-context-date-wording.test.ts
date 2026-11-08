/** One Code's date reminder and date-change notice: Claude Code's words. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("date wording", () => {
	it("states today's date, and a change of date without asking for an announcement", () => {
		const words = requireText("context");
		expect(words.date({ date: "2026-09-26" })).toBe("Today's date is 2026-09-26.");
		expect(words.dateChanged({ date: "2026-09-27" })).toBe("The date has changed. Today's date is now 2026-09-27. No need to announce the new date — the user's own clock shows it.");
	});
});

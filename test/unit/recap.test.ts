import { describe, expect, it } from "vitest";
import { RECAP_PROMPT, RECENT_MESSAGE_WINDOW, recapLine, REFERENCE_MARK } from "../../extensions/recap/prompt.ts";

describe("recap prompt", () => {
	it("uses Claude Code's verbatim away-summary instruction", () => {
		expect(RECAP_PROMPT).toBe(
			"The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.",
		);
	});

	it("keeps CC's 30-message recent window and ※ mark", () => {
		expect(RECENT_MESSAGE_WINDOW).toBe(30);
		expect(REFERENCE_MARK).toBe("※");
	});
});

describe("recapLine", () => {
	it("prefixes the trimmed content with 'recap: '", () => {
		expect(recapLine("  Building the recap feature.  ")).toBe("recap: Building the recap feature.");
	});
});

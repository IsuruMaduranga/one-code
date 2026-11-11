/** The wording of the skill listing. The listing itself: skill-listing.test.ts. */
import { describe, expect, it } from "vitest";
import { skillResultText } from "../../extensions/tools/skill/text.ts";

describe("the skill listing text", () => {
	it("words an empty listing", () => {
		expect(skillResultText.available(undefined)).toBe("Available skills:\n(no skills available)");
	});
});

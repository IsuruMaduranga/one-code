/** One Code's wording for the skill listing (profile/text/skill/). The base's listing is in test/unit/skill-listing.test.ts. */
import { describe, expect, it } from "vitest";
import { skill } from "../text/skill/index.ts";
import { skillResultText } from "../../extensions/tools/skill/text.ts";

describe("One Code's skill listing text", () => {
	it("words an empty listing", () => {
		expect(skillResultText.available(undefined)).toBe("Available skills:\n(no skills available)");
	});
});

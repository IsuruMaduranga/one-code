/** One Code's words inside the token budget block. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("budget wording", () => {
	it("says how many tokens are left", () => {
		expect(requireText("contextBudget").tokensLeft({ left: 14_832_967 })).toBe("14832967 tokens left");
	});
});

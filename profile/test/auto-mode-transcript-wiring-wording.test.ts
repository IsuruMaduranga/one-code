/** One Code's refusal when the classifier's transcript overflows in a session with no user to ask. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("headless classifier overflow wording", () => {
	it("names the overflow and the headless mode", () => {
		expect(requireText("permissions").refused({ kind: "classifierOverflowHeadless" })).toBe("auto mode classifier transcript exceeded context window in headless mode");
	});
});

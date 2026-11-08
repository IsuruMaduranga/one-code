/** One Code's auto-mode setup instructions: strict JSON, and lists that only append. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("auto mode setup prompt wording", () => {
	it("demands strict JSON and says the lists append", () => {
		const { system } = requireText("autoModeSetup");
		expect(system).toContain("ONLY a JSON object");
		expect(system).toContain("append-only");
	});
});

/** One Code's safety-floor reason for a write to a file that grants permissions. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("consent store floor wording", () => {
	it("says the file holds permission rules", () => {
		expect(requireText("autoMode").floorReason({ kind: "control", token: "/home/u/.onecode/hooks/project-approvals.json" })).toContain("permission rules");
	});
});

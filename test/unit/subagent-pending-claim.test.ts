/**
 * The reminder after a turn that ended with a background run still pending:
 * nothing when no run is pending, else the profile's text for every pending
 * run, in order. One Code's wording is checked in profile/test/.
 */
import { describe, expect, it } from "vitest";
import { pendingClaimReminder } from "../../extensions/agents/subagents/pending-claim.ts";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";

describe("pendingClaimReminder", () => {
	it("says nothing when the turn ended with no run pending", () => {
		expect(pendingClaimReminder([])).toBeUndefined();
	});

	it("hands the profile every pending run, in order", () => {
		const one = [{ name: "count-src-python-files", taskId: "b1f7f47e" }];
		expect(pendingClaimReminder(one)).toBe(subagentResultText().pendingClaim({ runs: one }));
		const two = [
			{ name: "a", taskId: "1" },
			{ name: "b", taskId: "2" },
		];
		expect(pendingClaimReminder(two)).toBe(subagentResultText().pendingClaim({ runs: two }));
	});
});

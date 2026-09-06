import { describe, expect, it } from "vitest";
import { pendingClaimReminder } from "../../extensions/subagents/pending-claim.ts";

describe("pendingClaimReminder", () => {
	it("says nothing when the turn ended with no run pending", () => {
		expect(pendingClaimReminder([])).toBeUndefined();
	});

	it("names the run and offers both sanctioned ways to get the result", () => {
		const text = pendingClaimReminder([{ name: "count-src-python-files", taskId: "b1f7f47e" }]);
		expect(text).toContain("count-src-python-files (task b1f7f47e)");
		expect(text).toContain("task_output with block=true");
		expect(text).toMatch(/wait for the notification/i);
	});

	it("is conditional, never an accusation — the trigger fires on correct turns too", () => {
		const text = pendingClaimReminder([{ name: "explore-1", taskId: "aaa" }]) ?? "";
		// "if you gave the user a result" — a model that merely said "still running"
		// must be able to read this and do nothing.
		expect(text).toMatch(/if you gave the user a result/i);
		expect(text).not.toMatch(/you (fabricated|invented|lied)/i);
	});

	it("names every pending run and agrees in number", () => {
		const one = pendingClaimReminder([{ name: "a", taskId: "1" }]) ?? "";
		expect(one).toContain("was still running");
		expect(one).toContain("It has not reported");
		const two = pendingClaimReminder([
			{ name: "a", taskId: "1" },
			{ name: "b", taskId: "2" },
		]) ?? "";
		expect(two).toContain("a (task 1), b (task 2)");
		expect(two).toContain("were still running");
		expect(two).toContain("They have not reported");
	});
});

/**
 * The plan-mode results the golden session cannot reach: no user to approve,
 * and a plan too large to re-attach. plan-mode.test.ts checks the plan
 * file's name and the approval dialog; the plan-mode block itself is the
 * profile's (its own test).
 */
import { describe, expect, it } from "vitest";
import { planModeResultText } from "../../extensions/safety/plan-mode/text.ts";

describe("the plan-mode result text", () => {
	it("keeps a session with no user in plan mode and says so", () => {
		expect(planModeResultText().noApprover("/p/plan.md")).toBe(
			"Plan approval needs an interactive session, and this one has no user to approve it. The session stays in plan mode; the plan is recorded at /p/plan.md for the user to review. Do not try to implement it here.",
		);
	});

	it("names a plan too large to re-attach instead of inlining it", () => {
		expect(planModeResultText().reattached({ planFile: "/p/plan.md", chars: 50_000 })).toBe(
			"A plan file exists from plan mode at: /p/plan.md\n\nIt is too large to include here (50,000 characters); read it before continuing.\n\nIf this plan is relevant to the current work and not already complete, continue working on it.",
		);
		expect(planModeResultText().reattached({ planFile: "/p/plan.md", content: "# Plan", chars: 6 })).toContain("Plan contents:\n\n# Plan\n\n");
	});
});

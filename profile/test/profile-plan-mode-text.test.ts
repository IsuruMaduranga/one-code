/**
 * One Code's plan-mode wording (profile/text/plan-mode/) for the results the
 * golden session cannot reach: no user to approve, and a plan too large to
 * re-attach. The golden snapshot pins the bytes of every other text.
 */
import { describe, expect, it } from "vitest";
import { planModeText } from "../text/plan-mode/index.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";

const planMode = planModeText(ALL_LIVE);

describe("One Code's plan-mode text", () => {
	it("keeps a session with no user in plan mode and says so", () => {
		expect(planMode.noApprover("/p/plan.md")).toBe(
			"Plan approval needs an interactive session, and this one has no user to approve it. The session stays in plan mode; the plan is recorded at /p/plan.md for the user to review. Do not try to implement it here.",
		);
	});

	it("names a plan too large to re-attach instead of inlining it", () => {
		expect(planMode.reattached({ planFile: "/p/plan.md", chars: 50_000 })).toBe(
			"A plan file exists from plan mode at: /p/plan.md\n\nIt is too large to include here (50,000 characters); read it before continuing.\n\nIf this plan is relevant to the current work and not already complete, continue working on it.",
		);
		expect(planMode.reattached({ planFile: "/p/plan.md", content: "# Plan", chars: 6 })).toContain("Plan contents:\n\n# Plan\n\n");
	});
});

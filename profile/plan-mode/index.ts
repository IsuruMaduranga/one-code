/**
 * One Code's plan-mode text (the profile's `text.planMode`): Claude Code's
 * EnterPlanMode and ExitPlanMode descriptions and results (texts.ts), its
 * plan-mode instructions (reminder.ts), and the plan re-attached after a
 * compaction.
 */

import type { PlanModeText } from "../../extensions/plan-mode/text.ts";
import { buildPlanModeReminder } from "./reminder.ts";
import { approvedPlanText, enteredPlanModeText, enterPlanModeDescription, EXIT_PLAN_MODE_DESCRIPTION, exitedPlanModeText } from "./texts.ts";

const CONTINUE = "If this plan is relevant to the current work and not already complete, continue working on it.";

export const planMode: PlanModeText = {
	descriptions: { enter_plan_mode: enterPlanModeDescription, exit_plan_mode: EXIT_PLAN_MODE_DESCRIPTION },
	reminder: ({ planFile, planExists }) => buildPlanModeReminder(planFile, planExists),
	entered: enteredPlanModeText,
	notInPlanMode: "Not in plan mode, so there is no plan to approve. Call enter_plan_mode first, build the plan in the file it names, then call exit_plan_mode.",
	emptyPlan: (planFile) => `No plan to approve: ${planFile} is missing or empty. Write your plan there first, then call exit_plan_mode again.`,
	noApprover: (planFile) =>
		`Plan approval needs an interactive session, and this one has no user to approve it. The session stays in plan mode; the plan is recorded at ${planFile} for the user to review. Do not try to implement it here.`,
	approved: ({ planFile, plan }) => approvedPlanText(planFile, plan),
	exited: exitedPlanModeText,
	reattached: ({ planFile, content, chars }) =>
		content === undefined
			? `A plan file exists from plan mode at: ${planFile}\n\nIt is too large to include here (${chars.toLocaleString("en-US")} characters); read it before continuing.\n\n${CONTINUE}`
			: `A plan file exists from plan mode at: ${planFile}\n\nPlan contents:\n\n${content}\n\n${CONTINUE}`,
};

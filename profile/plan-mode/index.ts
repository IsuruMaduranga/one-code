/**
 * One Code's plan-mode text (the profile's `text.planMode`): Claude Code's
 * EnterPlanMode and ExitPlanMode descriptions and results (texts.ts), its
 * plan-mode instructions (reminder.ts), and the plan re-attached after a
 * compaction.
 */

import type { PlanModeText } from "../../extensions/plan-mode/text.ts";
import { buildPlanModeReminder } from "./reminder.ts";
import { approvedPlanText, enteredPlanModeText, enterPlanModeDescription, EXIT_PLAN_MODE_DESCRIPTION, exitedPlanModeText } from "./texts.ts";
import { type ToolPassages, withoutOff } from "../live-tools.ts";
import type { LiveTools } from "../../extensions/lib/live-tools.ts";

const CONTINUE = "If this plan is relevant to the current work and not already complete, continue working on it.";

const ENTER_PASSAGES: ToolPassages = {
	ask_user_question: ["   - If you would use ask_user_question to clarify the approach, use enter_plan_mode instead\n", "5. Use ask_user_question if you need to clarify approaches\n"],
	Agent: [" (use the Agent tool instead)"],
};
const EXIT_PASSAGES: ToolPassages = {
	ask_user_question: ["- If you have unresolved questions about requirements or approach, use ask_user_question first (in earlier phases)\n", "**Important:** Do NOT use ask_user_question to ask \"Is this plan okay?\" or \"Should I proceed?\" - that's exactly what THIS tool does. exit_plan_mode inherently requests user approval of your plan.\n", "3. Initial task: \"Add a new feature to handle user authentication\" - If unsure about auth method (OAuth, JWT, etc.), use ask_user_question first, then use exit plan mode tool after clarifying the approach.\n"],
};
const ENTERED_PASSAGES: ToolPassages = {
	ask_user_question: ["4. Use ask_user_question if you need to clarify the approach\n"],
};
const REMINDER_PASSAGES: ToolPassages = {
	edit: [["make incremental edits using the edit tool", "update it using the write tool"]],
	ask_user_question: [
		"\n3. Use ask_user_question to clarify any remaining questions with the user",
		["either using the ask_user_question tool OR calling exit_plan_mode. Do not stop unless it's for these 2 reasons", "calling exit_plan_mode, unless you stop to ask the user a question about requirements or approach"],
		"Use ask_user_question ONLY to clarify requirements or choose between approaches. ",
		[" - no text questions, no ask_user_question.", " - no text questions."],
		[" using the ask_user_question tool.", "."],
	],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const planModeText = (live: LiveTools): PlanModeText => ({
	descriptions: {
		enter_plan_mode: (form) => withoutOff(enterPlanModeDescription(form), live, ENTER_PASSAGES),
		exit_plan_mode: withoutOff(EXIT_PLAN_MODE_DESCRIPTION, live, EXIT_PASSAGES),
	},
	reminder: ({ planFile, planExists }) => withoutOff(buildPlanModeReminder(planFile, planExists), live, REMINDER_PASSAGES),
	entered: (planFile) => withoutOff(enteredPlanModeText(planFile), live, ENTERED_PASSAGES),
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
});

/**
 * One Code's plan-mode text (the profile's `text.planMode`): Claude Code's
 * EnterPlanMode and ExitPlanMode descriptions and results (texts.ts), its
 * plan-mode instructions (reminder.ts), and the plan re-attached after a
 * compaction.
 */

import type { LiveTools, PlanModeText } from "../../../extensions/sdk/profile.ts";
import { buildPlanModeReminder } from "./reminder.ts";
import { enterPlanModeDescription, EXIT_PLAN_MODE_DESCRIPTION } from "./texts.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

const ENTER_PASSAGES: ToolPassages = {
	ask_user_question: ["   - If you would use ask_user_question to clarify the approach, use enter_plan_mode instead\n", "5. Use ask_user_question if you need to clarify approaches\n"],
	Agent: [" (use the Agent tool instead)"],
};
const EXIT_PASSAGES: ToolPassages = {
	ask_user_question: ["- If you have unresolved questions about requirements or approach, use ask_user_question first (in earlier phases)\n", "**Important:** Do NOT use ask_user_question to ask \"Is this plan okay?\" or \"Should I proceed?\" - that's exactly what THIS tool does. exit_plan_mode inherently requests user approval of your plan.\n", "3. Initial task: \"Add a new feature to handle user authentication\" - If unsure about auth method (OAuth, JWT, etc.), use ask_user_question first, then use exit plan mode tool after clarifying the approach.\n"],
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
});

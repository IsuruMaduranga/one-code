/**
 * One Code's ask_user_question text (the profile's `text.askUser`): Claude
 * Code's AskUserQuestion description and parameter docs (description.ts) and
 * its result wording.
 */

import type { AskUserText, LiveTools } from "../../../extensions/sdk/profile.ts";
import { ASK_PARAMS, askDescription } from "./description.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

/** Names both plan-mode tools: cut when either is off. */
const PLAN_MODE_PASSAGE = ["\n\nPlan mode note: To switch into plan mode, use enter_plan_mode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask \"Is my plan ready?\", \"Should I proceed?\", or otherwise reference \"the plan\" in questions — plan approval goes through exit_plan_mode."] as const;

const ASK_PASSAGES: ToolPassages = {
	enter_plan_mode: PLAN_MODE_PASSAGE,
	exit_plan_mode: PLAN_MODE_PASSAGE,
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const askUserText = (live: LiveTools): AskUserText => ({
	description: (form) => withoutOff(askDescription(form), live, ASK_PASSAGES),
	promptSnippet: "Ask the user to decide between options when genuinely blocked",
	params: ASK_PARAMS,
});

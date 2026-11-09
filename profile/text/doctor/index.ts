/**
 * One Code's doctor text (the profile's `text.doctor`): the `/doctor fix`
 * prompt (fix-prompt.ts).
 */

import type { DoctorText, LiveTools } from "../../../extensions/sdk/profile.ts";
import { type ToolPassages, withoutOff } from "../../live-tools.ts";
import { doctorFixPrompt } from "./fix-prompt.ts";

const FIX_PASSAGES: ToolPassages = { ask_user_question: [" with the `ask_user_question` tool"] };

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const doctorText = (live: LiveTools): DoctorText => ({ fixPrompt: (input) => withoutOff(doctorFixPrompt(input), live, FIX_PASSAGES) });

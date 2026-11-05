/**
 * One Code's doctor text (the profile's `text.doctor`): the `/doctor fix`
 * prompt (fix-prompt.ts).
 */

import type { DoctorText } from "../../extensions/doctor/text.ts";
import { doctorFixPrompt } from "./fix-prompt.ts";

export const doctor: DoctorText = { fixPrompt: doctorFixPrompt };

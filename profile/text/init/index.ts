/** One Code's `/init` text (the profile's `text.init`): the prompt in prompt.ts. */

import type { InitText } from "../../../extensions/sdk/profile.ts";
import { initPrompt } from "./prompt.ts";

export const init: InitText = { prompt: initPrompt };

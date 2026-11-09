/**
 * One Code's plugin command text (the profile's `text.plugins`): what a
 * `` !`command` `` placeholder in a plugin command's body becomes when its
 * command fails, times out or writes too much.
 */

import type { PluginsText } from "../../../extensions/sdk/profile.ts";

export const plugins: PluginsText = {
	placeholderFailed: ({ osMessage }) => `command failed: ${osMessage}`,
	noBash: "no bash shell found",
	placeholderTimedOut: ({ seconds }) => `command timed out after ${seconds} seconds`,
	outputCut: ({ chars }) => `[output cut after ${chars} characters]`,
};

/**
 * One Code's auto-mode note for the session model (the profile's
 * `text.autoMode`): Claude Code's auto-mode note with One Code's tool names.
 */

import type { AutoModeText, LiveTools } from "../../../extensions/sdk/profile.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

const OPUS_NOTE =
	"While auto mode is active:\n\n" +
	"You can do much of your work through the bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated read, edit, or write tools. " +
	"The choice is yours: prefer edit or write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.";

const FABLE_NOTE =
	"While auto mode is active:\n\n" +
	"Do your work through the bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated read, edit, or write tools. " +
	"Fall back to a dedicated tool only when bash genuinely cannot do the job.";

const NOTE_PASSAGES: ToolPassages = {
	edit: [["the dedicated read, edit, or write tools", "the dedicated read or write tools"], ["prefer edit or write when", "prefer write when"]],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const autoModeText = (live: LiveTools): AutoModeText => ({
	systemNote: ({ firm }) => withoutOff(firm ? FABLE_NOTE : OPUS_NOTE, live, NOTE_PASSAGES),
});

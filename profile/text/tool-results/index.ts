/**
 * One Code's tool-result text (the profile's `text.toolResults`): Claude
 * Code's empty-result, no-match and persisted-output texts and its
 * user-rejection message, with One Code's note on saving a correction to
 * memory.
 */

import type { ToolResultsText } from "../../../extensions/sdk/profile.ts";

const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

const MEMORY_NOTE =
	"Note: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";

export const toolResults: ToolResultsText = {
	empty: ({ tool }) => `(${tool} completed with no output)`,
	noFilesFound: "No files found",
	persisted: ({ size, file, saveError }) =>
		saveError === undefined
			? `Output too large (${size}). Full output saved to: ${file}`
			: `Output too large (${size}) and could not be saved to ${file}: ${saveError}. Only this preview survives — re-run with a narrower query if more is needed.`,
	previewHeading: ({ kb }) => `Preview (first ${kb}KB):`,
	userDenial: ({ feedback }) => {
		const said = feedback?.trim();
		const next = said ? `To tell you how to proceed, the user said:\n${said}` : "STOP what you are doing and wait for the user to tell you how to proceed.";
		return `${REJECTED} ${next}\n\n${MEMORY_NOTE}`;
	},
};

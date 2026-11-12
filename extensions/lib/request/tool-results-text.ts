/**
 * The words of the shared tool-result rewrites, the way Claude Code words
 * them, with a note on saving a correction to memory: the text for a result
 * with no output, pi's empty find, a result too
 * large to send whole (lib/request/persisted-output.ts), a call the user declined
 * (lib/consent/user-denial.ts), and a write refused for carrying a secret placeholder. The `<persisted-output>` tags, the size format and
 * the preview's length are the base's.
 */

interface ToolResultsText {
	/** A tool that returned nothing; `tool` is its display name (Bash, Grep). */
	empty(p: { tool: string }): string;
	/** In place of pi's "No files found matching pattern". */
	noFilesFound: string;
	/** The block's first line: the output's size (formatted) and where all of it is, or why it could not be saved there. */
	persisted(p: { size: string; file: string; saveError?: string }): string;
	/** The line above the preview; `kb` is its length. */
	previewHeading(p: { kb: number }): string;
	/** The user declined the call; `feedback` is what they typed, when anything. */
	userDenial(p: { feedback?: string }): string;
	/** A file write refused because its input carries a `[secret:…]` placeholder, which would replace the real value it stands for (safety/secret-values). */
	secretPlaceholderWrite: string;
}

const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

const SAID = "To tell you how to proceed, the user said:\n";

/** A denial that carries the user's words, up to where they go (lib/consent/user-denial.ts reads it back). */
export const USER_DENIAL_REASON_PREFIX = `${REJECTED} ${SAID}`;

const MEMORY_NOTE =
	"Note: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";

export const toolResultsText: ToolResultsText = {
	empty: ({ tool }) => `(${tool} completed with no output)`,
	noFilesFound: "No files found",
	persisted: ({ size, file, saveError }) =>
		saveError === undefined
			? `Output too large (${size}). Full output saved to: ${file}`
			: `Output too large (${size}) and could not be saved to ${file}: ${saveError}. Only this preview survives — re-run with a narrower query if more is needed.`,
	previewHeading: ({ kb }) => `Preview (first ${kb}KB):`,
	userDenial: ({ feedback }) => {
		const said = feedback?.trim();
		const next = said ? `${SAID}${said}` : "STOP what you are doing and wait for the user to tell you how to proceed.";
		return `${REJECTED} ${next}\n\n${MEMORY_NOTE}`;
	},
	secretPlaceholderWrite:
		"This write contains a [secret] placeholder. It stands for a real value the file holds, which you were not shown; writing the placeholder would replace that value. Change the file with an edit that leaves the secret's line untouched, or ask the user to make the change.",
};

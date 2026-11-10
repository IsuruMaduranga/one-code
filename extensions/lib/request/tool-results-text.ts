/**
 * What the base's shared tool-result rewrites need from a profile (types
 * only): the text for a result with no output, pi's empty find, a result too
 * large to send whole (lib/request/persisted-output.ts), a call the user declined
 * (lib/consent/user-denial.ts), and a write refused for carrying a secret placeholder. The `<persisted-output>` tags, the size format and
 * the preview's length are the base's.
 */

export interface ToolResultsText {
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

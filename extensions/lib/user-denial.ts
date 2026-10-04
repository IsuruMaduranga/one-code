/**
 * The result a tool call gets when the user rejects it (pure): Claude Code's
 * denial text, shared by the permission prompt and plan-mode approval. With
 * the user's typed reason it carries their words (decisions/tools.md, "Denial
 * feedback carries the user's words") in Claude Code's "To tell you how to
 * proceed, the user said:" form; without one it tells the model to stop and
 * wait for the user.
 */

const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

const MEMORY_NOTE =
	"Note: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";

/** Claude Code's rejection text, with the user's reason when they typed one. */
export function userDenialText(feedback?: string): string {
	const said = feedback?.trim();
	const next = said ? `To tell you how to proceed, the user said:\n${said}` : "STOP what you are doing and wait for the user to tell you how to proceed.";
	return `${REJECTED} ${next}\n\n${MEMORY_NOTE}`;
}

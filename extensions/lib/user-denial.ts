/**
 * The result a tool call gets when the user rejects it, in the profile's
 * words (Claude Code's denial text in One Code's), shared by the permission
 * prompt and plan-mode approval. With the user's typed reason it carries their words (decisions/tools.md, "Denial
 * feedback carries the user's words") in Claude Code's "To tell you how to
 * proceed, the user said:" form; without one it tells the model to stop and
 * wait for the user.
 */

import { around } from "./template-probe.ts";
import { toolResultWords } from "./tool-results-words.ts";

export function userDenialText(feedback?: string): string {
	return toolResultWords().userDenial(feedback === undefined ? {} : { feedback });
}

/**
 * Whether a tool result is the user's rejection, for the transcript: `stop`
 * when they rejected without a reason, `reason` when they gave one, undefined
 * for anything else. The transcript shows a short line for either (Claude
 * Code's); the model still reads the whole text.
 */
export function userDenialKind(text: string): "stop" | "reason" | undefined {
	const words = toolResultWords();
	if (text.startsWith(words.userDenial({}))) return "stop";
	// The text up to where the user's words go, from the profile's own wording.
	const reasonPrefix = around((feedback) => words.userDenial({ feedback }))?.before;
	return reasonPrefix && text.startsWith(reasonPrefix) ? "reason" : undefined;
}

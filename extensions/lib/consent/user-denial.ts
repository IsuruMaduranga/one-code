/**
 * The result a tool call gets when the user rejects it (Claude Code's
 * denial text, lib/request/tool-results-text.ts), shared by the permission
 * prompt and plan-mode approval. With the user's typed reason it carries their words (decisions/tools.md, "Denial
 * feedback carries the user's words") in Claude Code's "To tell you how to
 * proceed, the user said:" form; without one it tells the model to stop and
 * wait for the user.
 */

import { toolResultsText, USER_DENIAL_REASON_PREFIX } from "../request/tool-results-text.ts";

export function userDenialText(feedback?: string): string {
	return toolResultsText.userDenial(feedback === undefined ? {} : { feedback });
}

/**
 * Whether a tool result is the user's rejection, for the transcript: `stop`
 * when they rejected without a reason, `reason` when they gave one, undefined
 * for anything else. The transcript shows a short line for either (Claude
 * Code's); the model still reads the whole text.
 */
export function userDenialKind(text: string): "stop" | "reason" | undefined {
	if (text.startsWith(toolResultsText.userDenial({}))) return "stop";
	return text.startsWith(USER_DENIAL_REASON_PREFIX) ? "reason" : undefined;
}

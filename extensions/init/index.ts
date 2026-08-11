/**
 * init extension — Claude Code's `/init`.
 *
 * `/init` scans the repo and writes a concise CLAUDE.md for future sessions. It
 * is a prompt template, not procedural code: the handler submits INIT_PROMPT as
 * a user turn (pi.sendUserMessage) and the model does the work with the ordinary
 * tool set — subagent survey, ask_user_question, write. This mirrors how Claude
 * Code's `/init` is just a canned prompt.
 *
 * pi has no built-in `/init`, so a Claude Code user typing it would otherwise
 * have the word go to the model as a chat message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INIT_PROMPT } from "./prompt.ts";

export default function initExtension(pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Analyze the codebase and set up a CLAUDE.md for future sessions",
		// sendUserMessage always triggers a turn and returns void; the async
		// handler satisfies RegisteredCommand's Promise<void> contract.
		handler: async () => {
			pi.sendUserMessage(INIT_PROMPT, { deliverAs: "followUp" });
		},
	});
}

/**
 * init extension — Claude Code's `/init`.
 *
 * `/init` scans the repo and writes a CLAUDE.md for future sessions. It is a
 * prompt template, not procedural code: the handler submits INIT_PROMPT
 * (Claude Code's classic prompt) as a user turn (pi.sendUserMessage) and the
 * model does the work with the ordinary tool set, as Claude Code's `/init`
 * does.
 *
 * pi has no built-in `/init`, so a Claude Code user typing it would otherwise
 * have the word go to the model as a chat message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUserMessageSender } from "../lib/notifications.ts";
import { INIT_PROMPT } from "./prompt.ts";

export default function initExtension(pi: ExtensionAPI) {
	const sendUserMessage = createUserMessageSender(pi);
	pi.registerCommand("init", {
		description: "Initialize a new CLAUDE.md file with codebase documentation",
		handler: async (_args, ctx) => {
			await sendUserMessage(ctx, INIT_PROMPT, { deliverAs: "followUp" });
		},
	});
}

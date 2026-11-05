/**
 * init extension — Claude Code's `/init`.
 *
 * `/init` scans the repo and writes a CLAUDE.md for future sessions. It is a
 * prompt template, not procedural code: the handler submits the profile's prompt
 * (Claude Code's classic prompt) as a user turn (pi.sendUserMessage) and the
 * model does the work with the ordinary tool set, as Claude Code's `/init`
 * does.
 *
 * pi has no built-in `/init`, so a Claude Code user typing it would otherwise
 * have the word go to the model as a chat message.
 */

import { feature } from "../lib/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUserMessageSender } from "../lib/notifications.ts";
import { promptCommandText } from "../skill/invoke.ts";
import { requireText } from "../lib/profile.ts";

function initExtension(pi: ExtensionAPI) {
	const text = requireText("init");
	const sendUserMessage = createUserMessageSender(pi);
	pi.registerCommand("init", {
		description: "Initialize a new CLAUDE.md file with codebase documentation",
		handler: async (_args, ctx) => {
			await sendUserMessage(ctx, promptCommandText("init", "", text.prompt));
		},
	});
}

export default feature("init", initExtension);

/**
 * clear extension — Claude Code's `/clear`.
 *
 * Claude Code's `/clear` wipes the conversation and starts fresh in the same
 * working directory. pi's nearest primitive is `newSession()` (its built-in
 * command is `/new`). A user coming from Claude Code types `/clear` out of
 * habit; without this it isn't a command, so the word goes to the model as a
 * message instead of resetting context. This registers `/clear` alongside pi's
 * `/new`, routed through the same `newSession()` call.
 *
 * Nuance vs. Claude Code: CC clears history in place; pi starts a new session
 * file (same cwd, extensions, config). The user-facing effect is identical —
 * a clean context — which is what a `/clear` habit wants. Like `/exit`→`/quit`,
 * we cannot fold this into pi's `/new` palette entry (pi has no command
 * aliases), so `/clear` and `/new` are two entries that both reset.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Clear the conversation and start fresh (same as /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}

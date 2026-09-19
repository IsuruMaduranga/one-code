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
 *
 * Claude Code tells the model the conversation was cleared: the new
 * conversation opens with the `/clear` breadcrumb (caveat, command, empty
 * stdout — lib/local-command.ts). It cannot be queued from the handler: pi's
 * `newSession()` replaces the whole runtime (a `session_shutdown` with reason
 * "new" on the old extension runner, every factory run again — findings §8),
 * so a reminder queued before the call dies with the old queue. The NEW
 * instance announces it instead, from its `session_start` with reason "new" —
 * which is also what pi's own `/new` and an RPC `new_session` produce, and
 * they are the same user action as far as the model is concerned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announceLocalCommand } from "../lib/local-command.ts";

export default function clearExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Clear the conversation and start fresh (same as /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.on("session_start", (event) => {
		if ((event as { reason?: string }).reason === "new") announceLocalCommand(pi, { name: "clear" });
	});
}

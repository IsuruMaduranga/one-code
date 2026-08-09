/**
 * exit extension — Claude Code's `/exit`.
 *
 * pi's built-in quit command is `/quit`; Claude Code's is `/exit` (with `quit`
 * shown as an alias). A user coming from Claude Code types `/exit` out of habit
 * and, without this, it isn't a command — so it goes to the model as a message
 * instead of quitting. This registers `/exit` alongside pi's `/quit`, routed
 * through the same graceful path (`ctx.shutdown()` — "Gracefully shutdown pi and
 * exit", the same call `/quit` makes).
 *
 * We cannot reproduce Claude Code's single `/exit (quit)` palette entry that is
 * findable by either word: pi has no command aliases and its command palette
 * fuzzy-matches the command NAME only (`autocomplete.ts` — the description is
 * displayed but never searched). So `/exit` and the built-in `/quit` are two
 * separate entries, each found by its own name; both quit. That's the behaviour
 * a Claude Code user needs, without patching pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exitExtension(pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Quit One Code (same as /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}

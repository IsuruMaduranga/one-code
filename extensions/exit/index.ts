/**
 * exit extension — Claude Code's `/exit` and one-shot failure status.
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
import { RunOutcomeLatch } from "../lib/interrupt.ts";

export default function exitExtension(pi: ExtensionAPI) {
	const outcome = new RunOutcomeLatch();
	pi.on("agent_end", (event, ctx) => {
		outcome.record(event.messages, ctx.signal?.aborted);
	});
	pi.on("agent_settled", (_event, ctx) => {
		const settled = outcome.take();
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		if (settled !== "error") return;
		// pi 1.0.1 checks provider errors for text output, but not JSON. Wait
		// through retries/compaction and let pi flush output and dispose normally;
		// main preserves process.exitCode when runPrintMode returns zero. Never
		// overwrite an existing failure or affect interactive/RPC/child sessions.
		if (process.exitCode === undefined || Number(process.exitCode) === 0) process.exitCode = 1;
	});

	pi.registerCommand("exit", {
		description: "Quit One Code (same as /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}

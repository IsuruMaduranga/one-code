/**
 * Test-only commands for transition-probe.mjs. pi's RPC mode has no command
 * for `/tree` or `/reload`, but an extension command's context can do both
 * (`navigateTree`, `reload`), so the probe reaches them through these:
 *
 *   /probe-tree <entryId>   move the leaf to an entry (pi's /tree, no summary)
 *   /probe-reload           re-run every extension factory in-process (pi's /reload)
 *   /probe-late-tool        register and defer `probe_echo`, the way a late MCP
 *                           server's tool arrives mid-session
 *
 * With PROBE_LATE_TOOL=1 the tool is registered at session start instead, the
 * way a resumed process's MCP server connects again: the probe's fresh-process
 * oracle runs with it while the live process has the tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";

export const PROBE_TOOL_NAME = "probe_echo";

export default function transitionFixture(pi: ExtensionAPI): void {
	const registerLateTool = () => {
		pi.registerTool({
			name: PROBE_TOOL_NAME,
			label: PROBE_TOOL_NAME,
			description: "Echo the given text back.",
			parameters: Type.Object({ text: Type.String() }),
			async execute(_id, params) {
				return { content: [{ type: "text", text: `echo: ${params.text}` }], details: {} };
			},
		});
		pi.events.emit(DEFER_CHANNEL, { name: PROBE_TOOL_NAME, keywords: ["echo"] });
	};
	if (process.env.PROBE_LATE_TOOL === "1") pi.on("session_start", registerLateTool);
	pi.registerCommand("probe-tree", {
		description: "Probe only: move the leaf to an entry id",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) throw new Error("probe-tree needs an entry id");
			const result = await ctx.navigateTree(target, { summarize: false });
			if (result.cancelled) throw new Error(`probe-tree to ${target} was cancelled`);
		},
	});
	pi.registerCommand("probe-reload", {
		description: "Probe only: reload every extension",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
	pi.registerCommand("probe-late-tool", {
		description: "Probe only: register a deferred tool mid-session",
		handler: async () => registerLateTool(),
	});
}

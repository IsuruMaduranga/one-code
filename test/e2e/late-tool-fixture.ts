/**
 * Test-only late tool for cache-probe-late-tool.sh. It registers an echo tool
 * 200 ms after the session's first provider request and defers it, so the tool
 * arrives mid-session the way a late MCP server's tools do. tool-search then
 * announces it, as a reference-form `tool_addition` on a model that takes one
 * (request/tool-search/tool-additions.ts) and as the deferred-tool addendum elsewhere.
 *
 * It takes the name of an MCP resource tool, `list_mcp_resources`, which the
 * profile's deferred listing gives a hint, so its addendum line is `name: hint`
 * as a real late MCP tool's is, and the probe checks the reference still names
 * the tool. The mcp extension registers that name only for a server with
 * resources; if one already did, the fixture registers nothing and says so,
 * and the probe fails (the tool never reaches a request).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../../extensions/lib/request/deferred.ts";

export const LATE_TOOL_NAME = "list_mcp_resources";

export default function lateToolFixture(pi: ExtensionAPI): void {
	let scheduled = false;
	pi.on("before_provider_request", () => {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
			if (pi.getAllTools().some((tool) => tool.name === LATE_TOOL_NAME)) {
				process.stderr.write(`late-tool fixture: ${LATE_TOOL_NAME} is already registered (an MCP server with resources); nothing registered\n`);
				return;
			}
			pi.registerTool({
				name: LATE_TOOL_NAME,
				label: LATE_TOOL_NAME,
				description: "Echo the given text back.",
				parameters: Type.Object({ text: Type.String() }),
				async execute(_id, params) {
					return { content: [{ type: "text", text: `echo: ${params.text}` }], details: {} };
				},
			});
			pi.events.emit(DEFER_CHANNEL, { name: LATE_TOOL_NAME, keywords: ["echo"] });
		}, 200);
	});
}

/**
 * Test-only late tool for cache-probe-late-tool.sh. It registers `late_echo`
 * 200 ms after the session's first provider request and defers it, so the tool
 * arrives mid-session the way a late MCP server's tools do. tool-search then
 * announces it, as a reference-form `tool_addition` on a model that takes one
 * (lib/tool-additions.ts) and as the deferred-tool addendum elsewhere.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";

export const LATE_TOOL_NAME = "late_echo";

export default function lateToolFixture(pi: ExtensionAPI): void {
	let scheduled = false;
	pi.on("before_provider_request", () => {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
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

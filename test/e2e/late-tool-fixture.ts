/**
 * Test-only late tool for cache-probe-late-tool.sh. It registers `late_echo`
 * 200 ms after the session's first provider request and defers it, so the tool
 * arrives mid-session the way a late MCP server's tools do. tool-search then
 * announces it, as a reference-form `tool_addition` on a model that takes one
 * (request/tool-search/tool-additions.ts) and as the deferred-tool addendum elsewhere.
 *
 * The name is the fixture's own, so no tool the run loads (an MCP server's
 * resource tools, for one) can take it first or in its place. The profile has
 * no listing hint for it, so the fixture gives its own (`DeferRequest.hint`),
 * and its addendum line is `name: hint` as a real hinted late tool's is.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../../extensions/lib/request/deferred.ts";

export const LATE_TOOL_NAME = "late_echo";
/** The fixture's listing hint: its addendum line is `late_echo: <this>`. */
export const LATE_TOOL_HINT = "When you are about to echo a piece of text back unchanged, use it.";

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
			pi.events.emit(DEFER_CHANNEL, { name: LATE_TOOL_NAME, keywords: ["echo"], hint: LATE_TOOL_HINT });
		}, 200);
	});
}

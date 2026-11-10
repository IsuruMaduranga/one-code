/**
 * A minimal product extension for the base's own tests: it uses every seam
 * `extensions/sdk/extension.ts` offers (a prompt section, a reminder, a
 * deferred tool of its own) the way a product's extension would. The base
 * suite copies this profile into place, so the manifest's product entry loads
 * it there (`product-extension.test.ts`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL, type DeferRequest, REMINDER_CHANNEL, type ReminderPayload, SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection } from "../../../extensions/sdk/extension.ts";

export const PROBE_TOOL = "fixture_probe";
export const PROBE_SECTION = "[fixture:product-section]";
export const PROBE_REMINDER = "[fixture:product-reminder]";

export default function probe(pi: ExtensionAPI) {
	pi.registerTool({
		name: PROBE_TOOL,
		label: "Fixture probe",
		description: "[fixture:product-tool]",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "[fixture:product-tool-result]" }], details: undefined }),
	});
	pi.events.emit(DEFER_CHANNEL, { name: PROBE_TOOL } satisfies DeferRequest);
	pi.events.emit(SYSTEM_PROMPT_SECTION_CHANNEL, { id: "fixture-probe", place: "tail", render: () => PROBE_SECTION } satisfies SystemPromptSection);
	pi.on("session_start", () => {
		pi.events.emit(REMINDER_CHANNEL, { key: "fixture-probe", text: PROBE_REMINDER, placement: "last-append" } satisfies ReminderPayload);
	});
}

/**
 * search-tools extension — tier-aware activation of pi's built-in search tools.
 *
 * pi registers seven built-in tools but activates only read/bash/edit/write
 * (findings §2); grep/find/ls sit in the registry and are never activated.
 * This extension activates the three on the `tiny` tier, for small models
 * that search better with dedicated tools, and keeps them out of the other
 * tiers, where the shell covers search. The three are one unit
 * (`searchToolsEnabled`, lib/models/model-tier.ts): a profile that turns any
 * of them off (`tools: { grep: { enabled: false }, … }`) leaves search to the
 * shell on every tier, and the bash description is told the same answer.
 * The tier is frozen at session_start/model_select and shared over the event
 * bus, so capability refreshes cannot separate prompt text from the active
 * tool surface.
 */

import { feature } from "../../lib/profile/feature.ts";
import { toolLive } from "../../lib/profile/profile.ts";
import { searchToolsEnabled } from "../../lib/models/model-tier.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionModelTier } from "../../lib/models/session-model-tier.ts";
import { mergeGrepWindows } from "./grep-merge.ts";
import { withSearchTools } from "./tools.ts";

function searchToolsExtension(pi: ExtensionAPI) {
	const requestTier = sessionModelTier(pi);
	const apply = () => {
		const tier = requestTier();
		const active = pi.getActiveTools();
		const next = withSearchTools(active, searchToolsEnabled(tier, toolLive));
		if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
	};

	pi.on("session_start", apply);
	pi.on("model_select", apply);
	// pi restores the selected branch's tool loadout at a /tree switch.
	pi.on("session_tree", apply);

	// Overlapping context windows repeat lines (grep-merge.ts); without context
	// lines there are no windows to overlap.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "grep" || event.isError) return undefined;
		if (!(Number((event.input as { context?: unknown } | undefined)?.context) > 0)) return undefined;
		const first = event.content?.[0];
		if (first?.type !== "text" || typeof first.text !== "string") return undefined;
		const text = mergeGrepWindows(first.text);
		return text === first.text ? undefined : { content: [{ ...first, text }, ...event.content.slice(1)] };
	});
}

export default feature("search-tools", searchToolsExtension);

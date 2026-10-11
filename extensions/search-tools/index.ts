/**
 * search-tools extension — tier-aware activation of pi's built-in search tools.
 *
 * pi registers seven built-in tools but activates only read/bash/edit/write
 * (findings §2); grep/find/ls sit in the registry and are never activated.
 * Claude Code ships no Grep/Glob/LS on any tier (bash covers search — Haiku
 * included), so frontier/workhorse/cheap stay lean; only One Code's sub-Haiku
 * `tiny` tier, whose prompt steers to "the search tools", gets them in the
 * request. The tier is frozen at session_start/model_select and shared over
 * the event bus, so capability refreshes cannot separate prompt text from the
 * active tool surface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionModelTier } from "../lib/session-model-tier.ts";
import { mergeGrepWindows } from "./grep-merge.ts";
import { withSearchTools } from "./tools.ts";

export default function searchToolsExtension(pi: ExtensionAPI) {
	const requestTier = sessionModelTier(pi);
	const apply = () => {
		const tier = requestTier();
		const active = pi.getActiveTools();
		const next = withSearchTools(active, tier);
		if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
	};

	pi.on("session_start", apply);
	pi.on("model_select", apply);

	// Overlapping context windows repeat lines (grep-merge.ts).
	pi.on("tool_result", (event) => {
		if (event.toolName !== "grep" || event.isError) return undefined;
		const first = event.content?.[0];
		if (first?.type !== "text" || typeof first.text !== "string") return undefined;
		const text = mergeGrepWindows(first.text);
		return text === first.text ? undefined : { content: [{ ...first, text }, ...event.content.slice(1)] };
	});
}

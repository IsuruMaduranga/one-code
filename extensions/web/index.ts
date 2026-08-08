/**
 * web extension — Claude Code's WebSearch role.
 *
 * `web_search` comes from the community `pi-web-search` package, which calls the
 * *current model provider's own* search API (OpenAI/Codex, Anthropic, Gemini) —
 * no third-party key, and as close to Claude Code's server-side search as an
 * extension can get. It also registers Gemini-only `url_context`.
 *
 * WebFetch lives in `extensions/web-fetch` (our own); this file only owns search.
 *
 * Note: pi-web-search drives `setActiveTools` to hide `url_context` on non-Gemini
 * models. That composes with our deferral only because `tool-search` loads first
 * and therefore deactivates deferred tools before this package snapshots the
 * active set. Keep that ordering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch from "pi-web-search/src/index.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";

export default function webExtension(pi: ExtensionAPI) {
	webSearch(pi);

	// pi-web-search reports failures ("Failed: …" text, details.error set)
	// without isError, so a weak model can read a failure as a successful
	// search with odd content. Stamp isError here rather than patching the
	// vendor package.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "web_search" && event.toolName !== "url_context") return;
		if (event.isError) return;
		const details = event.details as { error?: unknown } | undefined;
		if (details?.error) return { isError: true };
	});

	pi.events.emit(DEFER_CHANNEL, {
		name: "web_search",
		keywords: ["web", "search", "internet", "google", "news", "lookup", "online", "current"],
	});
	pi.events.emit(DEFER_CHANNEL, {
		name: "url_context",
		keywords: ["url", "analyze page", "gemini"],
	});
}

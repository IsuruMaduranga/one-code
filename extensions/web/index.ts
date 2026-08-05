/**
 * web extension — Claude Code's WebSearch / WebFetch roles, from community
 * packages:
 *
 * - `pi-web-access` provides `fetch_content` (URL → markdown, GitHub repos,
 *   PDFs, images) and a key-based `web_search`.
 * - `pi-web-search` provides a provider-native `web_search` (the current
 *   model's own search API: OpenAI/Codex, Anthropic, Gemini) plus Gemini-only
 *   `url_context`.
 *
 * Load order inside this file is deliberate: pi-web-access first, then
 * pi-web-search, so the zero-config provider-native `web_search` overrides the
 * one that needs a third-party API key, while `fetch_content` is kept.
 *
 * All three tools are deferred behind `tool_search` — their schemas are large
 * and most turns never need them, which is what Claude Code does too.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webAccess from "pi-web-access/index.ts";
import webSearch from "pi-web-search/src/index.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";

export default function webExtension(pi: ExtensionAPI) {
	webAccess(pi);
	webSearch(pi);

	pi.events.emit(DEFER_CHANNEL, {
		name: "web_search",
		keywords: ["web", "search", "internet", "google", "news", "lookup", "online"],
	});
	pi.events.emit(DEFER_CHANNEL, {
		name: "fetch_content",
		keywords: ["fetch", "url", "webpage", "download", "read page", "http", "pdf", "youtube"],
	});
	pi.events.emit(DEFER_CHANNEL, {
		name: "url_context",
		keywords: ["url", "analyze page", "gemini"],
	});
}

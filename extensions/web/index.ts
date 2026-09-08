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
 * models. We register `url_context` as deferred only when a Gemini provider is
 * selected (see below), so on other providers it is neither listed as a deferred
 * tool nor advertised on the wire — matching pi-web-search's own gate.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch from "pi-web-search/src/index.ts";
import { getProviderKind } from "pi-web-search/src/api.ts";
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

	// url_context only works on a Gemini-compatible provider — pi-web-search's
	// own gate (getProviderKind === "google") deactivates the tool on anything
	// else, and its execute() there returns "url_context currently requires a
	// Google Gemini-compatible model". Registering it as deferred unconditionally
	// still advertised it in the names-only reminder (and as a defer_loading
	// definition) on every provider, so a non-Gemini model would load it and burn
	// two rounds discovering it cannot run (TOOL-FIDELITY-REVIEW-2026-09-07 M5).
	// Mirror pi-web-search's gate: register it once the first Gemini model is
	// seen. The one-shot flag keeps later session_tree/model_select events from
	// re-emitting (each emit past session_start takes the DEFER handler's
	// late-arrival path — deactivate + reschedule the listing rewrite — which is a
	// no-op once url_context is already registered).
	let urlContextDeferred = false;
	const deferUrlContextIfGemini = (model: { provider?: string; api?: string } | undefined) => {
		// ctx.model is undefined until a model resolves (session_start can fire
		// first), and getProviderKind dereferences model.provider without a guard —
		// so an undefined model must short-circuit here, as pi-web-search's own
		// `!!model && getProviderKind(...)` does.
		if (urlContextDeferred || !model || getProviderKind(model) !== "google") return;
		urlContextDeferred = true;
		pi.events.emit(DEFER_CHANNEL, { name: "url_context", keywords: ["url", "analyze page", "gemini"] });
	};
	pi.on("session_start", (_event, ctx) => deferUrlContextIfGemini(ctx.model));
	pi.on("session_tree", (_event, ctx) => deferUrlContextIfGemini(ctx.model));
	pi.on("model_select", (event) => deferUrlContextIfGemini(event.model));
}

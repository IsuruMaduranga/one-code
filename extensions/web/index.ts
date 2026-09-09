/**
 * web extension — Claude Code's WebSearch role.
 *
 * `web_search` is registered here with Claude Code's schema (`query`,
 * `allowed_domains`, `blocked_domains`) and routes by what the session can do:
 *
 *   1. Provider-native search through the community `pi-web-search` package
 *      when the current model's provider has one (Anthropic, OpenAI/Codex,
 *      Gemini, xAI) — no third-party key, and as close to Claude Code's
 *      server-side search as an extension can get.
 *   2. Otherwise the third-party chain in backends.ts: Brave, then Tavily when
 *      the user has a key (env var or `webSearch.apiKeys` in
 *      ~/.onecode/settings.json), and Exa's keyless hosted endpoint as the last
 *      resort — labelled in every result and announced once to the user, so a
 *      best-effort free route never passes for a configured one.
 *
 * pi-web-search's own registration still runs first: it wires the Gemini-only
 * `url_context` tool and the active-tools sync that hides it on non-Gemini
 * models. Its `web_search` is then overridden by ours — pi keeps one tool per
 * name per extension (`extension.tools.set(name, …)`), so a second
 * `registerTool` from the same extension replaces the vendor's entry.
 *
 * WebFetch lives in `extensions/web-fetch` (our own); this file only owns search.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { Type } from "typebox";
import webSearchPackage from "pi-web-search/src/index.ts";
import { getProviderKind } from "pi-web-search/src/api.ts";
import { webSearch as nativeWebSearch } from "pi-web-search/src/web_search.ts";
import { getWebSearchModel } from "pi-web-search/src/utils.ts";
import { readJsonFile } from "../lib/atomic-write.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { oneCodeSettingsPath } from "../lib/one-code-settings.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import {
	DEFAULT_MAX_RESULTS,
	formatSearchResults,
	KEYLESS_USER_NOTICE,
	resolveChain,
	runChain,
	webSearchSettingsFrom,
	withSiteOperators,
	type WebSearchSettings,
} from "./backends.ts";

/** `webSearch` from ~/.onecode/settings.json, read leniently — a bad file skips the setting, never breaks the tool. */
function readWebSearchSettings(): WebSearchSettings {
	return webSearchSettingsFrom(readJsonFile<{ webSearch?: unknown }>(oneCodeSettingsPath(homedir()))?.webSearch);
}

/** Declared up front: pi infers `details` from the first return it sees. */
interface SearchDetails {
	query?: string;
	backend?: string;
	keyless?: boolean;
	resultCount?: number;
	failures?: string[];
	native?: boolean;
	error?: unknown;
}

export default function webExtension(pi: ExtensionAPI) {
	// url_context + its active-tools sync, and the vendor web_search we override below.
	webSearchPackage(pi);

	// Once per session: the user is told the first time a search goes keyless.
	let keylessNoticeShown = false;

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		...ccToolRenderers<{ query?: string }>("Web Search", { title: (args) => args?.query }),
		description:
			"Search the web. Returns result blocks with titles and URLs.\n\n" +
			"- `allowed_domains` / `blocked_domains` filter results (enforced on Brave/Tavily/Exa; with provider-native search they become `site:` operators in the query, best-effort).\n" +
			'- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.\n' +
			"- Uses the model provider's own search when it has one; otherwise a configured search API (Brave, Tavily) or, with no key, a free rate-limited endpoint — the result names which.",
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query to use" }),
			allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only include search results from these domains" })),
			blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never include search results from these domains" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const filters = { allowed: params.allowed_domains, blocked: params.blocked_domains };

			// 1. Provider-native search (pi-web-search) when the current model — or a
			// web-search.json model — supports it. Its result text is passed through;
			// it reports failures as "Failed: …" text with details.error and no
			// isError, which a weak model can read as a successful search with odd
			// content, so isError is stamped here.
			const nativeModel = await getWebSearchModel(ctx);
			if (nativeModel) {
				const result = await nativeWebSearch(
					toolCallId,
					{ query: withSiteOperators(params.query, filters) },
					signal ?? new AbortController().signal,
					onUpdate,
					ctx,
				);
				// pi-web-search exposes no domain parameters and returns a synthesized
				// answer (nothing to post-filter), so the filters ride as `site:`
				// operators only — say so, rather than let the model assume enforcement.
				const hasFilters = Boolean(params.allowed_domains?.length || params.blocked_domains?.length);
				const content =
					hasFilters && !result.details?.error
						? [
								...result.content,
								{ type: "text" as const, text: "(Domain filters were applied as `site:` operators in the query — best-effort with provider-native search; verify the sources' hosts.)" },
							]
						: result.content;
				return {
					...result,
					content,
					details: { ...result.details, query: params.query, native: true, backend: `${nativeModel.provider}/${nativeModel.id}` } as SearchDetails,
					isError: Boolean(result.isError) || Boolean(result.details?.error),
				};
			}

			// 2. Third-party chain.
			const chain = resolveChain(process.env, readWebSearchSettings());
			onUpdate?.({
				content: [{ type: "text", text: `Searching ${chain[0]?.label ?? "the web"} for "${params.query}"...` }],
				details: { query: params.query } as SearchDetails,
			});
			try {
				const outcome = await runChain(chain, params.query, filters, DEFAULT_MAX_RESULTS, signal);
				if (outcome.backend.keyless && !keylessNoticeShown && ctx.hasUI) {
					keylessNoticeShown = true;
					ctx.ui.notify(KEYLESS_USER_NOTICE, "warning");
				}
				// Bounded by result count, but a provider's error body (quoted in
				// "Fell back after") or long snippets can still be large: persist, never slice.
				const text = persistIfLarge(formatSearchResults(params.query, outcome), { dir: sessionResultsDir(ctx), id: toolCallId });
				return {
					content: [{ type: "text", text }],
					details: {
						query: params.query,
						backend: outcome.backend.name,
						keyless: outcome.backend.keyless,
						resultCount: outcome.results.length,
						failures: outcome.failures.length ? outcome.failures : undefined,
					} as SearchDetails,
				};
			} catch (error) {
				const message = (error as Error).message;
				const text = persistIfLarge(
					`web_search failed on ${ctx.model?.provider}/${ctx.model?.id} (no native web search on this provider).\n${message}`,
					{ dir: sessionResultsDir(ctx), id: toolCallId },
				);
				return {
					content: [{ type: "text", text }],
					details: { query: params.query, error: message } as SearchDetails,
					isError: true,
				};
			}
		},
	});

	// url_context reports failures ("Failed: …" text, details.error set) without
	// isError. Stamp it here rather than patching the vendor package.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "url_context" || event.isError) return;
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

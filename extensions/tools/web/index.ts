/**
 * web extension — Claude Code's WebSearch role.
 *
 * `web_search` is registered here with Claude Code's schema (`query`,
 * `allowed_domains`, `blocked_domains`) and routes by what the session can do:
 *
 *   0. Anthropic's server-side `web_search` with dynamic filtering, in our own
 *      nested call, on a first-party Anthropic API-key session with a Claude
 *      4.6+ model available (lib/request/anthropic-server-tools.ts). pi-web-search's
 *      Anthropic call uses the older `web_search_20250305`, so it is the next
 *      step down, not this one.
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
 * WebFetch lives in `extensions/tools/web-fetch` (our own); this file only owns search.
 */

import { feature } from "../../lib/profile/feature.ts";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { Type } from "typebox";
import webSearchPackage from "pi-web-search/src/index.ts";
import { callApiStream, getConfig, getProviderKind } from "pi-web-search/src/api.ts";
import { getWebSearchModel } from "pi-web-search/src/utils.ts";
import { tryNativeWeb } from "../../lib/request/anthropic-server-call.ts";
import { nativeSearchBody, searchOutcome, searchSources, sourceLine, type ThinkingFields } from "../../lib/request/anthropic-server-tools.ts";
import { DeadlineError } from "../../lib/side-calls/operation-deadline.ts";
import { requireText } from "../../lib/profile/profile.ts";
import { readJsonFile } from "../../lib/core/atomic-write.ts";
import { recordUsage } from "../../lib/notify/usage-bus.ts";
import { DEFER_CHANNEL, WITHHOLD_CHANNEL } from "../../lib/request/deferred.ts";
import { productSettingsPath } from "../../lib/profile/product-settings.ts";
import { persistIfLarge, sessionResultsDir } from "../../lib/request/persisted-output.ts";
import { ccToolRenderers } from "../../lib/ui/tui-render.ts";
import { registerFormTool } from "../../lib/profile/tool-variants.ts";
import { nativeSearchResult, ProviderSearchError } from "./native-results.ts";
import { runNativeSearch } from "./native-call.ts";
import {
	DEFAULT_MAX_RESULTS,
	KEYLESS_USER_NOTICE,
	resolveChain,
	runChain,
	SearchChainError,
	webSearchSettingsFrom,
	withSiteOperators,
	type WebSearchSettings,
} from "./backends.ts";
import type { ChainFailure, ProviderSearchFailure } from "./text.ts";

/** `webSearch` from ~/.onecode/settings.json, read leniently — a bad file skips the setting, never breaks the tool. */
function readWebSearchSettings(): WebSearchSettings {
	return webSearchSettingsFrom(readJsonFile<{ webSearch?: unknown }>(productSettingsPath(homedir()))?.webSearch);
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

function webExtension(pi: ExtensionAPI) {
	const text = requireText("webSearch");
	const nativeWords = requireText("nativeWeb");
	// url_context + its active-tools sync, and the vendor web_search we override below.
	webSearchPackage(pi);

	// Once per session: the user is told the first time a search goes keyless.
	let keylessNoticeShown = false;
	// Per-session: the thinking-off fields a native-call model turned out to need.
	const learnedNativeThinking = new Map<string, ThinkingFields>();

	// Short or long text by the model's tier (the profile's description, lib/profile/tool-variants.ts).
	const tool = defineTool({
		name: "web_search",
		label: "Web Search",
		...ccToolRenderers<{ query?: string }>("Web Search", { title: (args) => args?.query }),
		description: text.description("short"),
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: text.params.query }),
			allowed_domains: Type.Optional(Type.Array(Type.String(), { description: text.params.allowed_domains })),
			blocked_domains: Type.Optional(Type.Array(Type.String(), { description: text.params.blocked_domains })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const filters = { allowed: params.allowed_domains, blocked: params.blocked_domains };
			const filtered = Boolean(params.allowed_domains?.length || params.blocked_domains?.length);
			const cancelled = () => ({
				content: [{ type: "text" as const, text: text.cancelled(params.query) }],
				details: { query: params.query } as SearchDetails,
				isError: true,
			});
			// Notes on the routes that fell back, newest first, after the answer.
			const notes: string[] = [];
			const withNotes = (body: string) => [body, ...notes].join("\n\n");

			// 0. Anthropic's server-side search with dynamic filtering, on a
			// first-party Anthropic API-key session. The domain filters are enforced
			// by the search itself; it takes one list or the other, so a call with
			// both goes down the paths below. Anything short of an answer from real
			// results falls through, with a note saying why.
			const bothFilters = Boolean(params.allowed_domains?.length && params.blocked_domains?.length);
			if (!bothFilters) {
				const native = await tryNativeWeb(ctx, {
					body: (model) =>
						nativeSearchBody(nativeWords.searchSystem, { model, query: params.query, allowedDomains: params.allowed_domains, blockedDomains: params.blocked_domains }),
					outcome: searchOutcome,
					onUsage: (usage) => recordUsage(pi, "web-search", usage),
					learned: learnedNativeThinking,
					onStart: () =>
						onUpdate?.({
							content: [{ type: "text", text: `Searching with Anthropic's web search for "${params.query}"...` }],
							details: { query: params.query } as SearchDetails,
						}),
					signal,
				});
				if (native.kind === "cancelled") return cancelled();
				if (native.kind === "answered") {
					const sources = searchSources(native.result);
					const answer = text.nativeAnswer({ answer: native.text, cutOff: native.cutOff, sourceLines: sources.map(sourceLine), spec: native.spec, filtered });
					return {
						content: [{ type: "text", text: persistIfLarge(answer, { dir: sessionResultsDir(ctx), id: toolCallId }) }],
						details: { query: params.query, native: true, backend: `anthropic web_search via ${native.spec}`, resultCount: sources.length } as SearchDetails,
					};
				}
				if (native.kind === "fell-back") notes.unshift(text.nativeFellBack(nativeWords.fallback(native.fallback)));
			}

			// 1. Reuse pi-web-search's transport, not its tool wrapper: that wrapper
			// truncates before we can persist the full answer and its sources.
			const nativeModel = await getWebSearchModel(ctx);
			if (nativeModel) {
				const backend = `${nativeModel.provider}/${nativeModel.id}`;
				try {
					const config = getConfig(nativeModel);
					const response = await runNativeSearch((nativeSignal) => callApiStream(ctx, nativeModel, {
						contents: [{ role: "user", parts: [{ text: withSiteOperators(params.query, filters) }] }],
						...(config.kind === "google" ? { tools: [{ [config.searchTool!]: {} }] } : {}),
					}, (update) => { if (!nativeSignal.aborted) onUpdate?.(update); }, nativeSignal), signal);
					const result = nativeSearchResult(response);
					// This route returns a synthesized answer, not rows we can filter (`filtered`: `site:` operators).
					const answer = withNotes(text.providerAnswer({ answer: result.answer, sources: result.sources, extra: result.extra, backend, filtered }));
					return {
						content: [{ type: "text", text: persistIfLarge(answer, { dir: sessionResultsDir(ctx), id: toolCallId }) }],
						details: { ...result.details, query: params.query, native: true, backend } as SearchDetails,
					};
				} catch (error) {
					if (signal?.aborted) return cancelled();
					const failure: ProviderSearchFailure =
						error instanceof ProviderSearchError
							? error.failure
							: error instanceof DeadlineError
								? { kind: "timedOut", seconds: error.timeoutMs / 1000 }
								: { kind: "other", osMessage: error instanceof Error ? error.message : String(error) };
					notes.unshift(text.providerFailed({ backend, failure }));
				}
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
				const results = text.chainResults({
					query: params.query,
					label: outcome.backend.label,
					attempts: outcome.attempts,
					keyless: outcome.backend.keyless,
					results: outcome.results,
				});
				return {
					content: [{ type: "text", text: persistIfLarge(withNotes(results), { dir: sessionResultsDir(ctx), id: toolCallId }) }],
					details: {
						query: params.query,
						backend: outcome.backend.name,
						keyless: outcome.backend.keyless,
						resultCount: outcome.results.length,
						failures: outcome.attempts.length ? outcome.attempts.map(text.attempt) : undefined,
					} as SearchDetails,
				};
			} catch (error) {
				const failure: ChainFailure = error instanceof SearchChainError ? error.failure : { kind: "other", osMessage: (error as Error).message };
				const message = text.failed({ model: `${ctx.model?.provider}/${ctx.model?.id}`, failure });
				return {
					content: [{ type: "text", text: persistIfLarge(withNotes(message), { dir: sessionResultsDir(ctx), id: toolCallId }) }],
					details: { query: params.query, error: message } as SearchDetails,
					isError: true,
				};
			}
		},
	});
	registerFormTool(pi, tool, text.description);

	// url_context reports failures ("Failed: …" text, details.error set) without
	// isError. Stamp it here rather than patching the vendor package.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "url_context" || event.isError) return;
		const details = event.details as { error?: unknown } | undefined;
		if (details?.error) return { isError: true };
	});

	pi.events.emit(DEFER_CHANNEL, { name: "web_search", keywords: text.searchKeywords });

	// url_context only works on a Gemini-compatible provider — pi-web-search's
	// own gate (getProviderKind === "google") deactivates the tool on anything
	// else, and its execute() there returns "url_context currently requires a
	// Google Gemini-compatible model". Registering it as deferred unconditionally
	// still advertised it in the names-only reminder (and as a defer_loading
	// definition) on every provider, so a non-Gemini model would load it and burn
	// two rounds discovering it cannot run (TOOL-FIDELITY-REVIEW-2026-09-07 M5).
	// Mirror that gate in the deferred registry too: withdraw on leaving Gemini
	// and re-defer on returning. Emit only when availability changes, since a
	// repeated defer would deactivate a tool already loaded through tool_search.
	// The registry owns announcements and keeps the cached listing frozen.
	let urlContextDeferred = false;
	const deferUrlContextIfGemini = (model: { provider?: string; api?: string } | undefined) => {
		// session_start can run before a model resolves; getProviderKind requires one.
		const available = !!model && getProviderKind(model) === "google";
		if (available === urlContextDeferred) return;
		urlContextDeferred = available;
		if (available) {
			pi.events.emit(DEFER_CHANNEL, { name: "url_context", keywords: ["url", "analyze page", "gemini"] });
		} else {
			pi.events.emit(WITHHOLD_CHANNEL, { name: "url_context" });
		}
	};
	pi.on("session_start", (_event, ctx) => deferUrlContextIfGemini(ctx.model));
	pi.on("session_tree", (_event, ctx) => deferUrlContextIfGemini(ctx.model));
	pi.on("model_select", (event) => deferUrlContextIfGemini(event.model));
}

export default feature("web", webExtension);

/**
 * web extension — Claude Code's WebSearch role.
 *
 * `web_search` is registered here with Claude Code's schema (`query`,
 * `allowed_domains`, `blocked_domains`) and routes by what the session can do:
 *
 *   0. Anthropic's server-side `web_search` with dynamic filtering, in our own
 *      nested call, on a first-party Anthropic API-key session with a Claude
 *      4.6+ model available (lib/anthropic-server-tools.ts). pi-web-search's
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
 * WebFetch lives in `extensions/web-fetch` (our own); this file only owns search.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { Type } from "typebox";
import webSearchPackage from "pi-web-search/src/index.ts";
import { getProviderKind } from "pi-web-search/src/api.ts";
import { webSearch as nativeWebSearch } from "pi-web-search/src/web_search.ts";
import { getWebSearchModel } from "pi-web-search/src/utils.ts";
import { tryNativeWeb } from "../lib/anthropic-server-call.ts";
import { CUT_OFF_NOTE, nativeSearchBody, searchOutcome, searchSources, sourceLine, type ThinkingFields } from "../lib/anthropic-server-tools.ts";
import { readJsonFile } from "../lib/atomic-write.ts";
import { recordUsage } from "../lib/usage-bus.ts";
import { DEFER_CHANNEL, WITHHOLD_CHANNEL } from "../lib/deferred.ts";
import { oneCodeSettingsPath } from "../lib/one-code-settings.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { registerFormTool } from "../lib/tool-variants.ts";
import { webSearchDescription } from "./description.ts";
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
	// Per-session: the thinking-off fields a native-call model turned out to need.
	const learnedNativeThinking = new Map<string, ThinkingFields>();

	// Short or long text by the model's tier (description.ts, lib/tool-variants.ts).
	const tool = defineTool({
		name: "web_search",
		label: "Web Search",
		...ccToolRenderers<{ query?: string }>("Web Search", { title: (args) => args?.query }),
		description: webSearchDescription("short"),
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query to use" }),
			allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only include search results from these domains" })),
			blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never include search results from these domains" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const filters = { allowed: params.allowed_domains, blocked: params.blocked_domains };

			// 0. Anthropic's server-side search with dynamic filtering, on a
			// first-party Anthropic API-key session. The domain filters are enforced
			// by the search itself; it takes one list or the other, so a call with
			// both goes down the paths below. Anything short of an answer from real
			// results falls through, with a note saying why.
			let nativeNote: string | undefined;
			const bothFilters = Boolean(params.allowed_domains?.length && params.blocked_domains?.length);
			if (!bothFilters) {
				const native = await tryNativeWeb(ctx, {
					body: (model) =>
						nativeSearchBody({ model, query: params.query, allowedDomains: params.allowed_domains, blockedDomains: params.blocked_domains }),
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
				if (native.kind === "cancelled") {
					return {
						content: [{ type: "text", text: `Search for "${params.query}" was cancelled.` }],
						details: { query: params.query } as SearchDetails,
						isError: true,
					};
				}
				if (native.kind === "answered") {
					const sources = searchSources(native.result);
					const filtered = Boolean(params.allowed_domains?.length || params.blocked_domains?.length);
					const text = [
						native.text,
						...(native.cutOff ? ["", CUT_OFF_NOTE] : []),
						"",
						"Sources:",
						...sources.map(sourceLine),
						"",
						`(Searched with Anthropic's server-side web search with dynamic filtering, on ${native.spec}${filtered ? "; the domain filters were enforced by the search" : ""}.)`,
					].join("\n");
					return {
						content: [{ type: "text", text: persistIfLarge(text, { dir: sessionResultsDir(ctx), id: toolCallId }) }],
						details: { query: params.query, native: true, backend: `anthropic web_search via ${native.spec}`, resultCount: sources.length } as SearchDetails,
					};
				}
				if (native.kind === "fell-back") {
					nativeNote = `(Anthropic's server-side web search did not answer (${native.reason}); the results below come from the next search route.)`;
				}
			}
			const withNativeNote = <T extends { type: string }>(content: T[]) =>
				nativeNote ? [...content, { type: "text" as const, text: nativeNote }] : content;

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
				const content = withNativeNote(
					hasFilters && !result.details?.error
						? [
								...result.content,
								{ type: "text" as const, text: "(Domain filters were applied as `site:` operators in the query — best-effort with provider-native search; verify the sources' hosts.)" },
							]
						: result.content,
				);
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
					content: withNativeNote([{ type: "text" as const, text }]),
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
					content: withNativeNote([{ type: "text" as const, text }]),
					details: { query: params.query, error: message } as SearchDetails,
					isError: true,
				};
			}
		},
	});
	registerFormTool(pi, tool, webSearchDescription);

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

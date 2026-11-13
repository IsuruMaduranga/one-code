/**
 * web-fetch extension — Claude Code's WebFetch.
 *
 * Fetches a URL, extracts the readable content, and returns markdown. Deferred
 * behind `tool_search`. With a `prompt`, a small same-containment reader model
 * (chosen in summarize.ts, same one-shot `completeSimple` shape as the
 * auto-mode classifier) answers it against the *full* page, keeping long pages
 * out of the main conversation. A reader failure falls back to the raw
 * windowed markdown with a note saying so — the original reason this feature
 * was deferred was that a summariser failing *silently* degrades quality
 * invisibly, so the fallback is loud, never silent.
 *
 * On a first-party Anthropic API-key session, `prompt` goes to Anthropic's
 * server-side web fetch first (lib/request/anthropic-server-tools.ts); it falls back
 * to the local fetch and reader above, with a note, whenever it does not
 * answer from a successful fetch.
 */

import { sessionView } from "../../lib/agents/child-extensions.ts";
import { brand } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordUsage } from "../../lib/notify/usage-bus.ts";
import { releaseSideCalls, runSideCall } from "../../lib/side-calls/side-call-run.ts";
import { DeadlineError, runWithDeadline } from "../../lib/side-calls/operation-deadline.ts";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../../lib/request/deferred.ts";
import { CrossHostRedirect, htmlToMarkdown, isSameHost, normalizeUrl, paginate } from "./extract.ts";
import { pickReaderModel, READER_MAX_CHARS, READER_MAX_TOKENS, readerMessages } from "./summarize.ts";
import { tryNativeWeb } from "../../lib/request/anthropic-server-call.ts";
import { fetchOutcome, isPrivateOrLocalUrl, nativeFetchBody, type ThinkingFields } from "../../lib/request/anthropic-server-tools.ts";
import { persistIfLarge, sessionResultsDir } from "../../lib/request/persisted-output.ts";
import { toolRenderers } from "../../lib/ui/tui-render.ts";
import { registerFormTool } from "../../lib/profile/tool-variants.ts";
import { readResponseText, WebFetchFailure } from "./response.ts";
import { pageContent } from "./page-content.ts";
import type { FetchAnswer, ReaderFailure, WebFetchText } from "./text.ts";
import { webFetchResultText } from "./text.ts";
import { nativeWebResultText } from "../../lib/request/native-web-text.ts";

const DEFAULT_MAX_CHARS = 30_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
/** Same-host redirect hops followed before giving up (a redirect loop is otherwise unbounded recursion). */
const MAX_REDIRECTS = 5;
/** Cache entries kept; the oldest is evicted past this (the TTL alone never evicted). */
const MAX_CACHE_ENTRIES = 50;
/** Longer than the classifier's cap: the reader ingests whole pages. */
const READER_TIMEOUT_MS = 60_000;
const USER_AGENT = `${brand.idPrefix}/0.1 (+${brand.homepage})`;

/**
 * Declared up front because pi infers a tool's `details` generic from the first
 * `return` it sees; an early `details: {}` would narrow every field to undefined.
 */
interface FetchDetails {
	url?: string;
	totalChars?: number;
	truncated?: boolean;
	nextOffset?: number;
	/** `provider/id` of the model that answered `prompt`, when one did. */
	reader?: string;
	/** Which fetch answered: Anthropic's server-side tool or the local client. */
	path?: "native" | "local";
}

interface CacheEntry {
	markdown: string;
	title?: string;
	fetchedAt: number;
	/** The page had no article structure, so the whole page was converted. */
	noArticle?: boolean;
}

/**
 * One-shot reader call, the same shape as the auto-mode classifier: no tools,
 * no agent session or history — the page and the question in, an answer out.
 * A per-session reader key keeps implicit caches on the same host. Anthropic
 * already marks the system and user blocks; only the short system repeats
 * across different pages, below its cache minimum. Never pad it for caching.
 * `reasoning` and `temperature` are deliberately not sent; both fail *closed*
 * on providers that reject them (see the classifier notes), and a reader that
 * errors turns into the raw-content fallback, wasting the fetch.
 */
async function answerFromPage(
	words: WebFetchText,
	ctx: ExtensionContext,
	prompt: string,
	entry: { markdown: string; title?: string },
	url: string,
	signal: AbortSignal | undefined,
	/** Per-session memo of a reader model's required thinking level, so a reader that
	 * cannot disable thinking pays the mandatory-thinking 400 once, not per fetch. */
	learnedReasoning: Map<string, ThinkingLevel>,
	/** Report the reader call's usage for the all-in footer cost. */
	recordCall: (usage: unknown) => void,
): Promise<{ answer: string; reader: string; truncated: boolean; cutOff: boolean } | { failure: ReaderFailure }> {
	const choice = pickReaderModel(ctx.modelRegistry.getAvailable(), ctx.model);
	if (!choice) return { failure: { kind: "noModel" } };
	const reader = `${choice.model.provider}/${choice.model.id}`;

	try {
		// Registry auth takes no signal, so it gets the deadline here; runSideCall
		// bounds each model attempt itself, and a late resolution starts nothing.
		const auth = await runWithDeadline(() => ctx.modelRegistry.getApiKeyAndHeaders(choice.model), {
			signal,
			timeoutMs: READER_TIMEOUT_MS,
			message: "web_fetch: the reader's credentials did not resolve in time",
		});
		if (!auth.ok) return { failure: { kind: "error", reader, osMessage: auth.error } };
		const messages = readerMessages(words, { prompt, markdown: entry.markdown, url, title: entry.title });
		// Thinking off unless the model cannot disable it; withReasoningFallback sends
		// a level up front for catalog-marked models and retries on the 400 for the
		// rest, memoizing the result so repeated fetches don't re-pay the failure.
		const result = await runSideCall({
			kind: "reader",
			model: choice.model,
			auth,
			sessionId: ctx.sessionManager.getSessionId(),
			context: {
				systemPrompt: messages.system,
				messages: [{ role: "user" as const, content: messages.user, timestamp: Date.now() }],
			},
			signal,
			timeoutMs: READER_TIMEOUT_MS,
			maxTokens: READER_MAX_TOKENS,
			learnedReasoning,
			onUsage: recordCall,
		});
		if (result.stopReason !== "stop" && result.stopReason !== "length") {
			return {
				failure: result.errorMessage
					? { kind: "error", reader, osMessage: result.errorMessage }
					: { kind: "stoppedEarly", reader, stopReason: String(result.stopReason) },
			};
		}
		const answer = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!answer) return { failure: { kind: "noText", reader } };
		return { answer, reader, truncated: messages.truncated, cutOff: result.stopReason === "length" };
	} catch (error) {
		if (error instanceof DeadlineError) return { failure: { kind: "credentialsTimeout", reader, seconds: error.timeoutMs / 1000 } };
		return { failure: { kind: "error", reader, osMessage: (error as Error).message } };
	}
}

function webFetchExtension(pi: ExtensionAPI) {
	const view = sessionView(pi);
	const text = view.text("webFetch");
	const nativeWords = view.text("nativeWeb");
	// Same 15-minute window Claude Code documents, so repeated reads of one page
	// during a task don't re-download it.
	const cache = new Map<string, CacheEntry>();
	// Per-session: a reader model's learned required thinking level (see answerFromPage).
	const learnedReasoning = new Map<string, ThinkingLevel>();
	// Per-session: the thinking-off fields a native-call model turned out to need.
	const learnedNativeThinking = new Map<string, ThinkingFields>();
	// A child is disposed without this event; disposeChildSession releases its keys.
	pi.on("session_shutdown", (_event, ctx) => releaseSideCalls(ctx.sessionManager.getSessionId()));

	const load = async (url: string, signal: AbortSignal | undefined, redirects = 0): Promise<CacheEntry> => {
		signal?.throwIfAborted();
		const cached = cache.get(url);
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		let response: Response | undefined;

		try {
			response = await fetch(url, {
				redirect: "manual",
				signal: controller.signal,
				headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,*/*" },
			});

			// Cross-host redirects are reported rather than followed, matching Claude
			// Code, so a redirect can't quietly take the agent somewhere else.
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (location) {
					const target = new URL(location, url).toString();
					if (isSameHost(target, url)) {
						if (redirects >= MAX_REDIRECTS) throw new WebFetchFailure({ kind: "tooManyRedirects", max: MAX_REDIRECTS, lastTarget: target });
						void response.body?.cancel().catch(() => {});
						// Each hop inherits the first request's deadline as well as caller cancellation.
						return await load(target, controller.signal, redirects + 1);
					}
					throw new CrossHostRedirect(target, response.status);
				}
			}

			if (!response.ok) {
				throw new WebFetchFailure({ kind: "httpStatus", status: response.status, statusText: response.statusText });
			}

			const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
			const body = await readResponseText(response, controller.signal);

			let entry: CacheEntry;
			if (contentType.includes("html")) {
				const extracted = await htmlToMarkdown(body, url);
				entry = {
					markdown: extracted.markdown,
					title: extracted.title,
					fetchedAt: Date.now(),
					noArticle: extracted.fallback,
				};
			} else if (contentType.includes("json")) {
				entry = { markdown: `\`\`\`json\n${body.trim()}\n\`\`\``, fetchedAt: Date.now() };
			} else {
				entry = { markdown: body.trim(), fetchedAt: Date.now() };
			}

			cache.set(url, entry);
			while (cache.size > MAX_CACHE_ENTRIES) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) break;
				cache.delete(oldest);
			}
			return entry;
		} finally {
			void response?.body?.cancel().catch(() => {});
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};

	// Short or long text by the model's tier (the profile's description, lib/profile/tool-variants.ts).
	const tool = defineTool({
		name: "web_fetch",
		label: "Web Fetch",
		...toolRenderers("Web Fetch"),
		description: text.description("short"),
		parameters: Type.Object({
			url: Type.String({ description: text.params.url }),
			prompt: Type.Optional(Type.String({ description: text.params.prompt })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: text.params.offset })),
			max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 100_000, description: text.params.max_chars(DEFAULT_MAX_CHARS) })),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const normalized = normalizeUrl(params.url);
			if ("problem" in normalized) {
				return {
					content: [{ type: "text", text: webFetchResultText(view.live).urlRejected(normalized.problem) }],
					details: {} as FetchDetails,
					isError: true,
				};
			}
			const target = normalized.url;
			const upgraded = normalized.upgraded === true;
			/** Why Anthropic's server-side fetch did not answer `prompt`, when it was asked and fell back. */
			let nativeFallback: string | undefined;
			const cancelled = () => ({ content: [{ type: "text" as const, text: webFetchResultText(view.live).cancelled(target) }], details: { url: target }, isError: true });
			/** The header and the framed page, bounded for the model. */
			const resultText = (answer: FetchAnswer, page: { body: string; title?: string }, noArticle = false) =>
				persistIfLarge(`${webFetchResultText(view.live).header({ url: target, upgraded, nativeFallback, noArticle, answer })}\n\n${pageContent(webFetchResultText(view.live).page, page.body, page.title)}`, {
					dir: sessionResultsDir(ctx),
					id: toolCallId,
				});

			if (signal?.aborted) return cancelled();

			// With `prompt` on a first-party Anthropic API-key session, Anthropic's
			// server-side fetch answers it with dynamic filtering. Anything short of
			// an answer from a successful fetch falls through to the local path,
			// with a note saying why (lib/request/anthropic-server-tools.ts fetchOutcome).
			// Without `prompt` the local path always answers: it pages with
			// `offset`, which the server tool cannot.
			if (params.prompt && !isPrivateOrLocalUrl(target)) {
				const prompt = params.prompt;
				const native = await tryNativeWeb(ctx, {
					body: (model) => nativeFetchBody(nativeWords.fetch, { model, url: target, prompt }),
					outcome: fetchOutcome,
					onUsage: (usage) => recordUsage(pi, "web-fetch", usage),
					learned: learnedNativeThinking,
					signal,
				});
				if (native.kind === "cancelled") return cancelled();
				if (native.kind === "answered") {
					const answer: FetchAnswer = { kind: "native", reader: native.spec, cutOff: native.cutOff };
					return { content: [{ type: "text", text: resultText(answer, { body: native.text }) }], details: { url: target, reader: native.spec, path: "native" } };
				}
				if (native.kind === "fell-back") nativeFallback = nativeWebResultText.fallback(native.fallback);
			}

			try {
				const entry = await load(target, signal);

				// Reader failures degrade to the raw page below — loudly, via
				// readerFailure, never silently.
				let readerFailure: ReaderFailure | undefined;
				if (params.prompt) {
					const answered = await answerFromPage(text, ctx, params.prompt, entry, target, signal, learnedReasoning, (usage) =>
						recordUsage(pi, "reader", usage),
					);
					signal?.throwIfAborted();
					if ("answer" in answered) {
						const answer: FetchAnswer = {
							kind: "reader",
							reader: answered.reader,
							pageChars: entry.markdown.length,
							readChars: answered.truncated ? READER_MAX_CHARS : undefined,
							cutOff: answered.cutOff,
						};
						return {
							content: [{ type: "text", text: resultText(answer, { body: answered.answer, title: entry.title }, entry.noArticle) }],
							details: { url: target, totalChars: entry.markdown.length, reader: answered.reader, path: "local" },
						};
					}
					readerFailure = answered.failure;
				}

				const offset = params.offset ?? 0;
				const page = paginate(entry.markdown, offset, params.max_chars ?? DEFAULT_MAX_CHARS);
				const window = page.truncated ? { from: offset, to: offset + page.text.length, total: page.totalChars, next: page.nextOffset! } : undefined;
				const answer: FetchAnswer = { kind: "raw", window, readerFailure };

				return {
					content: [{ type: "text", text: resultText(answer, { body: page.text, title: entry.title }, entry.noArticle) }],
					details: {
						url: target,
						totalChars: page.totalChars,
						truncated: page.truncated,
						nextOffset: page.nextOffset,
						path: "local",
					},
				};
			} catch (error) {
				// Node's fetch() reports "fetch failed" / "This operation was aborted"
				// for DNS, connection, and timeout errors alike — the real cause hides
				// in error.cause, and a timeout is indistinguishable from a cancel by
				// name alone. Unpack all three so the model sees what actually failed
				// and what to try next.
				if (error instanceof CrossHostRedirect) {
					const redirect = webFetchResultText(view.live).redirect({ originalUrl: target, redirectUrl: error.redirectUrl, status: error.status, prompt: params.prompt });
					return { content: [{ type: "text", text: redirect }], details: { url: target } };
				}
				const err = error as Error & { cause?: unknown };
				const aborted = err.name === "AbortError" || err.name === "TimeoutError";
				if (signal?.aborted) return cancelled();
				const failure =
					error instanceof WebFetchFailure
						? error.failure
						: aborted
							? ({ kind: "timedOut", seconds: FETCH_TIMEOUT_MS / 1000 } as const)
							: ({ kind: "network", osMessage: err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message } as const);
				return { content: [{ type: "text", text: webFetchResultText(view.live).failed({ url: target, failure }) }], details: { url: target }, isError: true };
			}
		},
	});
	registerFormTool(pi, tool, text.description);

	pi.events.emit(DEFER_CHANNEL, { name: "web_fetch", keywords: text.searchKeywords });
}

export default feature("web-fetch", webFetchExtension);

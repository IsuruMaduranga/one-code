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
 * server-side web fetch first (lib/anthropic-server-tools.ts); it falls back
 * to the local fetch and reader above, with a note, whenever it does not
 * answer from a successful fetch.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordUsage } from "../lib/usage-bus.ts";
import { runSideCall } from "../lib/side-call-run.ts";
import { runWithDeadline } from "../lib/operation-deadline.ts";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { CrossHostRedirect, htmlToMarkdown, isSameHost, normalizeUrl, paginate, redirectMessage } from "./extract.ts";
import { pickReaderModel, READER_MAX_CHARS, READER_MAX_TOKENS, readerMessages } from "./summarize.ts";
import { tryNativeWeb } from "../lib/anthropic-server-call.ts";
import { CUT_OFF_NOTE, fetchOutcome, isPrivateOrLocalUrl, nativeFetchBody, type ThinkingFields } from "../lib/anthropic-server-tools.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { registerFormTool } from "../lib/tool-variants.ts";
import { webFetchDescription } from "./description.ts";
import { readResponseText } from "./response.ts";
import { pageContent } from "./page-content.ts";


const DEFAULT_MAX_CHARS = 30_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
/** Same-host redirect hops followed before giving up (a redirect loop is otherwise unbounded recursion). */
const MAX_REDIRECTS = 5;
/** Cache entries kept; the oldest is evicted past this (the TTL alone never evicted). */
const MAX_CACHE_ENTRIES = 50;
/** Longer than the classifier's cap: the reader ingests whole pages. */
const READER_TIMEOUT_MS = 60_000;
const USER_AGENT = "one-code/0.1 (+https://github.com/IsuruMaduranga/one-code)";

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
	note?: string;
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
): Promise<{ answer?: string; reader?: string; truncated?: boolean; cutOff?: boolean; error?: string }> {
	const choice = pickReaderModel(ctx.modelRegistry.getAvailable(), ctx.model);
	if (!choice) return { error: "no model available to read the page" };
	const reader = `${choice.model.provider}/${choice.model.id}`;

	try {
		return await runWithDeadline(async (readerSignal) => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
			// Registry auth cannot take a signal; a late resolution must not start a model call.
			readerSignal.throwIfAborted();
			if (!auth.ok) return { error: `${reader}: ${auth.error}` };
			const messages = readerMessages({ prompt, markdown: entry.markdown, url, title: entry.title });
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
				signal: readerSignal,
				timeoutMs: READER_TIMEOUT_MS,
				maxTokens: READER_MAX_TOKENS,
				learnedReasoning,
				onUsage: recordCall,
			});
			if (result.stopReason !== "stop" && result.stopReason !== "length") {
				return { error: `${reader}: ${result.errorMessage || `the call stopped early (${result.stopReason})`}` };
			}
			const answer = result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (!answer) return { error: `${reader} returned no text` };
			return { answer, reader, truncated: messages.truncated, cutOff: result.stopReason === "length" };
		}, { signal, timeoutMs: READER_TIMEOUT_MS, message: "The reader did not answer within 60 seconds." });
	} catch (error) {
		return { error: `${reader}: ${(error as Error).message}` };
	}
}

export default function webFetchExtension(pi: ExtensionAPI) {
	// Same 15-minute window Claude Code documents, so repeated reads of one page
	// during a task don't re-download it.
	const cache = new Map<string, CacheEntry>();
	// Per-session: a reader model's learned required thinking level (see answerFromPage).
	const learnedReasoning = new Map<string, ThinkingLevel>();
	// Per-session: the thinking-off fields a native-call model turned out to need.
	const learnedNativeThinking = new Map<string, ThinkingFields>();

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
						if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (${MAX_REDIRECTS}); last target ${target}`);
						void response.body?.cancel().catch(() => {});
						// Each hop inherits the first request's deadline as well as caller cancellation.
						return await load(target, controller.signal, redirects + 1);
					}
					throw new CrossHostRedirect(target, response.status);
				}
			}

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
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
					note: extracted.fallback ? "No article structure found; converted the whole page." : undefined,
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

	// Short or long text by the model's tier (description.ts, lib/tool-variants.ts).
	const tool = defineTool({
		name: "web_fetch",
		label: "Web Fetch",
		...ccToolRenderers("Web Fetch"),
		description: webFetchDescription("short"),
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http is upgraded to https)" }),
			prompt: Type.Optional(
				Type.String({
					description:
						"Question to answer from the page. A small same-provider model reads the whole page and returns just the answer, keeping long pages out of context. Omit to get the raw page markdown",
				}),
			),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset to resume from for a long page" }),
			),
			max_chars: Type.Optional(
				Type.Integer({ minimum: 1000, maximum: 100_000, description: `Characters to return (default ${DEFAULT_MAX_CHARS})` }),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			let target: string;
			let normalizeNote: string | undefined;
			try {
				const normalized = normalizeUrl(params.url);
				target = normalized.url;
				normalizeNote = normalized.note;
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: {} as FetchDetails,
					isError: true,
				};
			}

			if (signal?.aborted) {
				return { content: [{ type: "text", text: `Fetch of ${target} was cancelled.` }], details: { url: target }, isError: true };
			}

			// With `prompt` on a first-party Anthropic API-key session, Anthropic's
			// server-side fetch answers it with dynamic filtering. Anything short of
			// an answer from a successful fetch falls through to the local path,
			// with a note saying why (lib/anthropic-server-tools.ts fetchOutcome).
			// Without `prompt` the local path always answers: it pages with
			// `offset`, which the server tool cannot.
			let nativeNote: string | undefined;
			if (params.prompt && !isPrivateOrLocalUrl(target)) {
				const prompt = params.prompt;
				const native = await tryNativeWeb(ctx, {
					body: (model) => nativeFetchBody({ model, url: target, prompt }),
					outcome: fetchOutcome,
					onUsage: (usage) => recordUsage(pi, "web-fetch", usage),
					learned: learnedNativeThinking,
					signal,
				});
				if (native.kind === "cancelled") {
					return { content: [{ type: "text", text: `Fetch of ${target} was cancelled.` }], details: { url: target }, isError: true };
				}
				if (native.kind === "answered") {
					const header = [
						`Source: ${target}`,
						normalizeNote,
						`Answered by ${native.spec} with Anthropic's server-side web fetch (dynamic filtering). Refetch without \`prompt\` for the raw content.`,
						native.cutOff ? CUT_OFF_NOTE : undefined,
					]
						.filter(Boolean)
						.join("\n");
					const text = persistIfLarge(`${header}\n\n${pageContent(native.text)}`, { dir: sessionResultsDir(ctx), id: toolCallId });
					return { content: [{ type: "text", text }], details: { url: target, reader: native.spec, path: "native" } };
				}
				if (native.kind === "fell-back") {
					nativeNote = `Anthropic's server-side fetch did not answer (${native.reason}); fetched the page locally instead.`;
				}
			}

			try {
				const entry = await load(target, signal);

				// Reader failures degrade to the raw page below — loudly, via
				// readerNote, never silently.
				let readerNote: string | undefined;
				if (params.prompt) {
					const answered = await answerFromPage(ctx, params.prompt, entry, target, signal, learnedReasoning, (usage) =>
						recordUsage(pi, "reader", usage),
					);
					signal?.throwIfAborted();
					if (answered.answer !== undefined) {
						const header = [
							`Source: ${target}`,
							normalizeNote,
							nativeNote,
							entry.note,
							answered.truncated
								? `Answered by ${answered.reader} from the first ${READER_MAX_CHARS} characters of the page and title; the rest was not read. Refetch without \`prompt\` (with \`offset\`) for the raw content.`
								: `Answered by ${answered.reader} from the full page (${entry.markdown.length} chars). Refetch without \`prompt\` for the raw content.`,
							answered.cutOff ? "(The answer was cut off at the reader's output limit and may be incomplete.)" : undefined,
						]
							.filter(Boolean)
							.join("\n");
						return {
							content: [{ type: "text", text: persistIfLarge(`${header}\n\n${pageContent(answered.answer, entry.title)}`, { dir: sessionResultsDir(ctx), id: toolCallId }) }],
							details: { url: target, totalChars: entry.markdown.length, reader: answered.reader, path: "local" },
						};
					}
					readerNote = `Could not answer \`prompt\` (${answered.error}); returning the raw page content instead.`;
				}

				const page = paginate(entry.markdown, params.offset ?? 0, params.max_chars ?? DEFAULT_MAX_CHARS);

				const header = [
					`Source: ${target}`,
					normalizeNote,
					nativeNote,
					entry.note,
					readerNote,
					page.truncated
						? `Showing characters ${params.offset ?? 0}–${(params.offset ?? 0) + page.text.length} of ${page.totalChars}. Continue with offset ${page.nextOffset}.`
						: undefined,
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text", text: persistIfLarge(`${header}\n\n${pageContent(page.text, entry.title)}`, { dir: sessionResultsDir(ctx), id: toolCallId }) }],
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
					return { content: [{ type: "text", text: redirectMessage(target, error, params.prompt) }], details: { url: target } };
				}
				const err = error as Error & { cause?: unknown };
				const aborted = err.name === "AbortError" || err.name === "TimeoutError";
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: `Fetch of ${target} was cancelled.` }],
						details: { url: target },
						isError: true,
					};
				}
				const reason = aborted
					? `timed out after ${FETCH_TIMEOUT_MS / 1000}s — the site may be slow, unreachable, or blocking automated requests`
					: err.cause instanceof Error
						? `${err.message}: ${err.cause.message}`
						: err.message;
				return {
					content: [
						{
							type: "text",
							text: `Could not fetch ${target}: ${reason}. Verify the URL and host, retry, or use web_search instead.`,
						},
					],
					details: { url: target },
					isError: true,
				};
			}
		},
	});
	registerFormTool(pi, tool, webFetchDescription);

	pi.events.emit(DEFER_CHANNEL, {
		name: "web_fetch",
		keywords: ["fetch", "url", "webpage", "web page", "read page", "http", "download", "docs", "article"],
	});
}

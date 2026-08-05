/**
 * web-fetch extension — Claude Code's WebFetch.
 *
 * Fetches a URL, extracts the readable content, and returns markdown. Deferred
 * behind `tool_search`.
 *
 * Deviation from Claude Code, deliberate: CC answers a `prompt` against the page
 * using a small fast model. pi exposes no clean in-process completion helper, and
 * a summarisation call that silently fails would degrade quality invisibly — so
 * this returns the extracted markdown (windowed) and lets the main model read it.
 * Long pages are paginated via `offset` rather than summarised.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { htmlToMarkdown, isSameHost, normalizeUrl, paginate } from "./extract.ts";

const DEFAULT_MAX_CHARS = 30_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "pincer/0.1 (+https://github.com/earendil-works/pi)";

/**
 * Declared up front because pi infers a tool's `details` generic from the first
 * `return` it sees; an early `details: {}` would narrow every field to undefined.
 */
interface FetchDetails {
	url?: string;
	totalChars?: number;
	truncated?: boolean;
	nextOffset?: number;
}

interface CacheEntry {
	markdown: string;
	title?: string;
	fetchedAt: number;
	note?: string;
}

export default function webFetchExtension(pi: ExtensionAPI) {
	// Same 15-minute window Claude Code documents, so repeated reads of one page
	// during a task don't re-download it.
	const cache = new Map<string, CacheEntry>();

	const load = async (url: string, signal: AbortSignal | undefined): Promise<CacheEntry> => {
		const cached = cache.get(url);
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		timer.unref?.();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const response = await fetch(url, {
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
						return await load(target, signal);
					}
					throw new Error(`Redirects to a different host: ${target}\nCall web_fetch again with that URL if you want it.`);
				}
			}

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const body = await response.text();

			let entry: CacheEntry;
			if (contentType.includes("html")) {
				const extracted = htmlToMarkdown(body, url);
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
			return entry;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its readable content as markdown. Navigation and boilerplate are stripped. Long pages are windowed — pass `offset` to continue reading. Responses are cached for 15 minutes. Cross-host redirects are reported instead of followed; call again with the new URL to follow one.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http is upgraded to https)" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset to resume from for a long page" }),
			),
			max_chars: Type.Optional(
				Type.Integer({ minimum: 1000, maximum: 100_000, description: `Characters to return (default ${DEFAULT_MAX_CHARS})` }),
			),
		}),
		async execute(_toolCallId, params, signal) {
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

			try {
				const entry = await load(target, signal);
				const page = paginate(entry.markdown, params.offset ?? 0, params.max_chars ?? DEFAULT_MAX_CHARS);

				const header = [
					entry.title ? `# ${entry.title}` : undefined,
					`Source: ${target}`,
					normalizeNote,
					entry.note,
					page.truncated
						? `Showing characters ${params.offset ?? 0}–${(params.offset ?? 0) + page.text.length} of ${page.totalChars}. Continue with offset ${page.nextOffset}.`
						: undefined,
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text", text: `${header}\n\n${page.text}` }],
					details: {
						url: target,
						totalChars: page.totalChars,
						truncated: page.truncated,
						nextOffset: page.nextOffset,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not fetch ${target}: ${(error as Error).message}` }],
					details: { url: target },
					isError: true,
				};
			}
		},
	});

	pi.events.emit(DEFER_CHANNEL, {
		name: "web_fetch",
		keywords: ["fetch", "url", "webpage", "web page", "read page", "http", "download", "docs", "article"],
	});
}

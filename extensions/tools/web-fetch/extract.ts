/**
 * URL handling and HTML → markdown extraction (pure).
 */

import type TurndownService from "turndown";
import type { UrlProblem } from "./text.ts";

/**
 * linkedom + turndown + readability cost ~90ms to load (findings §15), so they
 * are imported on the first fetch rather than at startup. The promise is
 * cached: concurrent fetches share one load.
 */
let libsPromise:
	| Promise<{
			Readability: typeof import("@mozilla/readability").Readability;
			parseHTML: typeof import("linkedom").parseHTML;
			Turndown: typeof TurndownService;
	  }>
	| undefined;

function loadLibs() {
	libsPromise ??= Promise.all([import("@mozilla/readability"), import("linkedom"), import("turndown")]).then(
		([readability, linkedom, turndown]) => ({
			Readability: readability.Readability,
			parseHTML: linkedom.parseHTML,
			// turndown is CJS (`export =`): the class arrives as `default` under
			// Node's ESM interop, or as the module itself under require-style loaders.
			Turndown:
				(turndown as { default?: typeof TurndownService }).default ?? (turndown as unknown as typeof TurndownService),
		}),
	);
	return libsPromise;
}

export interface NormalizedUrl {
	url: string;
	/** The input was http and is now https, so the tool can say so. */
	upgraded?: true;
}

/** Upgrades http to https and rejects non-web schemes, as Claude Code's WebFetch does. */
export function normalizeUrl(input: string): NormalizedUrl | { problem: UrlProblem } {
	const trimmed = input.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { problem: { kind: "invalid", input } };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { problem: { kind: "scheme", protocol: parsed.protocol } };
	if (parsed.username || parsed.password) return { problem: { kind: "credentials" } };
	if (!parsed.hostname.replace(/\.+$/, "").includes(".")) return { problem: { kind: "noDot" } };
	if (parsed.protocol === "http:") {
		parsed.protocol = "https:";
		return { url: parsed.toString(), upgraded: true };
	}
	return { url: parsed.toString() };
}

export function isSameHost(a: string, b: string): boolean {
	try {
		const target = new URL(a);
		const source = new URL(b);
		return target.host === source.host && target.protocol === source.protocol && !target.username && !target.password;
	} catch {
		return false;
	}
}

function createTurndown(Turndown: typeof TurndownService): TurndownService {
	const turndown = new Turndown({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	// Script/style survive Readability in some documents; drop them explicitly.
	turndown.remove(["script", "style", "noscript"]);
	return turndown;
}

export interface ExtractResult {
	title?: string;
	markdown: string;
	/** True when Readability found no article and the whole body was converted. */
	fallback: boolean;
}

/**
 * Extracts readable content and converts it to markdown. Readability is tried
 * first (it strips navigation and boilerplate); if it finds no article — common
 * for API references and landing pages — the whole body is converted instead.
 */
export async function htmlToMarkdown(html: string, url: string): Promise<ExtractResult> {
	const { Readability, parseHTML, Turndown } = await loadLibs();
	const { document } = parseHTML(html);
	const turndown = createTurndown(Turndown);
	// linkedom does not resolve relative attributes against the fetched URL.
	let base = url;
	try { base = new URL(document.querySelector("base[href]")?.getAttribute("href") ?? url, url).href; } catch { /* use the fetched URL */ }
	for (const [selector, attribute] of [["a[href]", "href"], ["img[src]", "src"]]) {
		for (const element of document.querySelectorAll(selector)) {
			try { element.setAttribute(attribute, new URL(element.getAttribute(attribute)!, base).href); } catch { /* keep malformed links as written */ }
		}
	}

	// Readability mutates the document, and linkedom can create an empty body
	// for a fragment. Keep the original content for the whole-page fallback.
	const body = document.querySelector("body")?.innerHTML ?? document.toString();
	// linkedom's Document is structurally compatible with what Readability needs
	// but is not the DOM lib's Document type, hence the cast.
	let article: { title?: string | null; content?: string | null } | null = null;
	try {
		article = new Readability(document as never).parse();
	} catch {
		article = null;
	}

	if (article?.content && article.content.trim().length > 0) {
		return {
			title: article.title ?? document.title ?? undefined,
			markdown: turndown.turndown(article.content).trim(),
			fallback: false,
		};
	}

	return {
		title: document.title || undefined,
		markdown: turndown.turndown(body).trim(),
		fallback: true,
	};
}

export interface Page {
	text: string;
	truncated: boolean;
	nextOffset?: number;
	totalChars: number;
}

/** Windows long content so a big page cannot swamp the context. */
export function paginate(text: string, offset: number, maxChars: number): Page {
	const start = Math.max(0, Math.min(offset, text.length));
	const slice = text.slice(start, start + maxChars);
	const end = start + slice.length;
	return {
		text: slice,
		truncated: end < text.length,
		nextOffset: end < text.length ? end : undefined,
		totalChars: text.length,
	};
}

/** A redirect to another host: reported, not followed (Claude Code's rule). Not a failure. */
export class CrossHostRedirect extends Error {
	constructor(
		readonly redirectUrl: string,
		readonly status: number,
	) {
		super(`Redirects to a different host: ${redirectUrl}`);
	}
}

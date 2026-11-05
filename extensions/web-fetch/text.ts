/**
 * What web_fetch needs from a profile (types only). The extension decides what
 * happened; the profile words it (working-docs/features/profiles/). The
 * `<page>` frame around fetched text and its escaping stay in the base
 * (page-content.ts): they hold the data boundary.
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

/** Why a URL was refused before any request. */
export type UrlProblem = { kind: "invalid"; input: string } | { kind: "scheme"; protocol: string } | { kind: "credentials" } | { kind: "noDot" };

/** Why a fetch failed. `osMessage` is the system's own text (with its cause), passed through. */
export type FetchFailure =
	| { kind: "httpStatus"; status: number; statusText: string }
	| { kind: "tooManyRedirects"; max: number; lastTarget: string }
	| { kind: "binary"; mime: string }
	| { kind: "tooLarge"; limitMiB: number }
	| { kind: "timedOut"; seconds: number }
	| { kind: "network"; osMessage: string };

/** Why the reader model did not answer `prompt`. `osMessage` is the provider's or the system's own text. */
export type ReaderFailure =
	| { kind: "noModel" }
	| { kind: "credentialsTimeout"; reader: string; seconds: number }
	| { kind: "stoppedEarly"; reader: string; stopReason: string }
	| { kind: "noText"; reader: string }
	| { kind: "error"; reader: string; osMessage: string };

/** What the result carries below its header. */
export type FetchAnswer =
	/** Anthropic's server-side fetch answered `prompt`. */
	| { kind: "native"; reader: string; cutOff: boolean; answer: string }
	/** The reader model answered `prompt`; `readChars` is set when the page was cut to fit it. */
	| { kind: "reader"; reader: string; pageChars: number; readChars?: number; cutOff: boolean; answer: string; title?: string }
	/** The page itself; `window` when it was cut, `readerFailure` when a `prompt` went unanswered. */
	| { kind: "raw"; text: string; title?: string; window?: { from: number; to: number; total: number; next: number }; readerFailure?: ReaderFailure };

export interface WebFetchText {
	/** Short on frontier and workhorse, long on cheap and tiny (lib/tool-variants.ts). */
	description(form: DescriptionForm): string;
	params: Record<"url" | "prompt" | "offset", string> & { max_chars(defaultChars: number): string };
	/** Search terms for `tool_search`, beyond the tool's name and description. */
	searchKeywords: string[];
	urlRejected(problem: UrlProblem): string;
	cancelled(url: string): string;
	failed(p: { url: string; failure: FetchFailure }): string;
	/** A redirect to another host: reported, not followed. `prompt` when the call had one. */
	redirect(p: { originalUrl: string; redirectUrl: string; status: number; prompt?: string }): string;
	/**
	 * The result's header, above the framed page. `upgraded`: http was
	 * upgraded to https; `nativeFallback`: why the server-side fetch did not
	 * answer, as the `nativeWeb` group words it; `noArticle`: the page had no
	 * article structure.
	 */
	header(p: { url: string; upgraded: boolean; nativeFallback?: string; noArticle: boolean; answer: FetchAnswer }): string;
	/** The words around the base's `<page>` frame, and the page title's line. */
	page: { before: string; after: string; title(title: string): string };
	/** The reader model's prompt; `page` is already framed. `cutAt` when the page was cut to fit. */
	reader: { system: string; user(p: { url: string; cutAt?: number; page: string; question: string }): string };
}

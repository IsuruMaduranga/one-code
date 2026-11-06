/**
 * One Code's web_fetch wording (profile/web-fetch/) for the results the golden
 * snapshot cannot reach offline: a server-side answer, a reader that fails or
 * is cut short, a timeout, a network error, an oversized download. The golden
 * snapshot pins the bytes of every other result.
 */
import { describe, expect, it } from "vitest";
import type { ReaderFailure } from "../../extensions/web-fetch/text.ts";
import { webFetchText } from "../../profile/web-fetch/index.ts";
import { ALL_LIVE } from "./helpers/live.ts";

const webFetch = webFetchText(ALL_LIVE);

const url = "https://example.com/a";
const base = { url, upgraded: false, noArticle: false };

describe("One Code's web_fetch text", () => {
	it("reports a cross-host redirect in Claude Code's shape, with the prompt line only when there was a prompt", () => {
		expect(webFetch.redirect({ originalUrl: "https://httpbin.org/redirect-to", redirectUrl: "https://example.com/", status: 302, prompt: "What is it?" })).toBe(
			[
				"REDIRECT DETECTED: The URL redirects to a different host.",
				"",
				"Original URL: https://httpbin.org/redirect-to",
				"Redirect URL: https://example.com/",
				"Status: 302 Found",
				"",
				"To complete your request, I need to fetch content from the redirected URL. Please use web_fetch again with these parameters:",
				'- url: "https://example.com/"',
				'- prompt: "What is it?"',
			].join("\n"),
		);
		const permanent = webFetch.redirect({ originalUrl: "https://a.com", redirectUrl: "https://b.com/", status: 301 });
		expect(permanent).not.toContain("prompt:");
		expect(permanent).toContain("Status: 301 Moved Permanently");
		expect(webFetch.redirect({ originalUrl: "https://a.com", redirectUrl: "https://b.com/", status: 308 })).toContain("Status: 308 Permanent Redirect");
	});

	it("says which model answered and whether its answer is whole", () => {
		expect(webFetch.header({ ...base, answer: { kind: "native", reader: "anthropic/m", cutOff: true } })).toBe(
			`Source: ${url}\nAnswered by anthropic/m with Anthropic's server-side web fetch (dynamic filtering). Refetch without \`prompt\` for the raw content.\n(The answer was cut off at the output limit and may be incomplete.)`,
		);
		expect(webFetch.header({ ...base, noArticle: true, answer: { kind: "reader", reader: "p/r", pageChars: 200_000, readChars: 100_000, cutOff: true } })).toBe(
			[
				`Source: ${url}`,
				"No article structure found; converted the whole page.",
				"Answered by p/r from the first 100000 characters of the page and title; the rest was not read. Refetch without `prompt` (with `offset`) for the raw content.",
				"(The answer was cut off at the reader's output limit and may be incomplete.)",
			].join("\n"),
		);
	});

	it("falls back to the raw page loudly when the reader fails", () => {
		expect(webFetch.header({ ...base, upgraded: true, nativeFallback: "the call failed: 500", answer: { kind: "raw", readerFailure: { kind: "noText", reader: "p/r" } } })).toBe(
			[
				`Source: ${url}`,
				"Upgraded http to https.",
				"Anthropic's server-side fetch did not answer (the call failed: 500); fetched the page locally instead.",
				"Could not answer `prompt` (p/r returned no text); returning the raw page content instead.",
			].join("\n"),
		);
	});

	it("words each reader failure", () => {
		const line = (failure: ReaderFailure) =>
			webFetch.header({ ...base, answer: { kind: "raw", readerFailure: failure } }).split("\n")[1];
		expect(line({ kind: "noModel" })).toBe("Could not answer `prompt` (no model available to read the page); returning the raw page content instead.");
		expect(line({ kind: "credentialsTimeout", reader: "p/r", seconds: 60 })).toContain("(p/r: The reader's credentials did not resolve within 60 seconds.)");
		expect(line({ kind: "stoppedEarly", reader: "p/r", stopReason: "error" })).toContain("(p/r: the call stopped early (error))");
		expect(line({ kind: "error", reader: "p/r", osMessage: "429 rate limited" })).toContain("(p/r: 429 rate limited)");
	});

	it("names the failure and the next step", () => {
		expect(webFetch.failed({ url, failure: { kind: "timedOut", seconds: 30 } })).toBe(
			`Could not fetch ${url}: timed out after 30s — the site may be slow, unreachable, or blocking automated requests. Verify the URL and host, retry, or use web_search instead.`,
		);
		expect(webFetch.failed({ url, failure: { kind: "network", osMessage: "fetch failed: getaddrinfo ENOTFOUND" } })).toContain(": fetch failed: getaddrinfo ENOTFOUND. Verify");
		expect(webFetch.failed({ url, failure: { kind: "tooLarge", limitMiB: 10 } })).toContain("Response exceeds the 10 MiB download limit; use bash to download the file instead.");
	});

	it("tells the reader where the page was cut", () => {
		expect(webFetch.reader.user({ url, cutAt: 100_000, page: "<page>", question: "q?" })).toBe(
			`Page: ${url}\n(The page was cut at 100000 characters; the tail is missing.)\n\n<page>\n\nQuestion: q?`,
		);
	});
});

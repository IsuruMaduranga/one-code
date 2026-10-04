/**
 * Test-only web response fixture for cache-probe-reader.sh.
 *
 * The URLs are loopback addresses so Anthropic's native server-side fetch path
 * deliberately declines them. This extension intercepts only these two exact
 * URLs; provider requests still use the real global fetch implementation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const READER_PROBE_LONG_URL = "https://handbook.example.com/editorial-guide";
export const READER_PROBE_SHORT_URL = "https://handbook.example.com/editorial-guide-short";
export const READER_PROBE_QUESTION = "What does section 12 require before publication?";

const sections = Array.from({ length: 60 }, (_, index) => {
	const number = index + 1;
	const requirement = number === 12 ? "Before publication, record the owner, review date, source links, and the decision that changed the guidance." : "Keep the source evidence with the section, state the responsible role, and review the guidance when the related process changes.";
	return `<h2>${number}. Guide section ${number}</h2><p>${requirement} The editorial guide explains why this protects readers: a claim remains useful when another person can trace it to a source, understand its scope, and see when it needs another review. Teams discuss exceptions in the change record rather than editing a published section without context.</p><p>Each section also asks the maintainer to use clear terms, preserve exact names and figures, and separate confirmed facts from future proposals. The guide is for people maintaining a public handbook, not a template for automated instructions.</p>`;
}).join("\n");

const pages = new Map<string, string>([
	[
		READER_PROBE_LONG_URL,
		`<!doctype html><html><head><title>Editorial evidence guide</title></head><body><main><h1>Editorial evidence guide</h1><p>This handbook explains how maintainers prepare a public technical guide.</p>${sections}</main></body></html>`,
	],
	[
		READER_PROBE_SHORT_URL,
		"<!doctype html><html><head><title>Short reader fixture</title></head><body><main><h1>Short reader fixture</h1><p>Section 12 requires a recorded owner before publication.</p></main></body></html>",
	],
]);

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

export default function readerCacheFetchFixture(_pi: ExtensionAPI): void {
	const original = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const body = pages.get(requestUrl(input));
		if (body === undefined) return original(input, init);
		return Promise.resolve(
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		);
	};
}

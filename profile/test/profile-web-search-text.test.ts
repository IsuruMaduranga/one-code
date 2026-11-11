/**
 * One Code's web_search and server-side web wording (profile/text/web-search/,
 * profile/text/native-web/) for the results the golden snapshot cannot reach
 * offline: the provider's own search answering, a cut-off server-side
 * answer, and the failures a canned backend does not produce. The golden
 * snapshot pins the bytes of every other result.
 */
import { describe, expect, it } from "vitest";
import { nativeWeb } from "../text/native-web/index.ts";
import { webSearchResultText } from "../../extensions/tools/web/text.ts";
import { nativeWebResultText } from "../../extensions/lib/request/native-web-text.ts";

describe("One Code's web_search text", () => {
	it("marks a server-side answer cut off at the output limit", () => {
		expect(webSearchResultText.nativeAnswer({ answer: "A.", cutOff: true, sourceLines: ["- [S](https://s.example/)"], spec: "anthropic/m", filtered: false })).toBe(
			"A.\n\n(The answer was cut off at the output limit and may be incomplete.)\n\nSources:\n- [S](https://s.example/)\n\n(Searched with Anthropic's server-side web search with dynamic filtering, on anthropic/m.)",
		);
	});

	it("lists the provider's sources and other hits, and flags best-effort filters", () => {
		expect(
			webSearchResultText.providerAnswer({
				answer: "A.",
				sources: [{ title: "S", url: "https://s.example/" }],
				extra: [{ url: "https://x.example/" }],
				backend: "google/gemini",
				filtered: true,
			}),
		).toBe(
			[
				"A.",
				"## Sources\n1. [S](https://s.example/)",
				"## Additional Search Results\n1. https://x.example/ - https://x.example/",
				"(Searched with google/gemini.)",
				"(Domain filters were applied as `site:` operators in the query — best-effort with provider-native search; verify the sources' hosts.)",
			].join("\n\n"),
		);
		expect(webSearchResultText.providerAnswer({ answer: "A.", sources: [], extra: [], backend: "b", filtered: false })).toBe("A.\n\n(Searched with b.)");
	});

	it("says why the provider's own search did not answer", () => {
		const note = (failure: Parameters<typeof webSearchResultText.providerFailed>[0]["failure"]) => webSearchResultText.providerFailed({ backend: "p/m", failure });
		expect(note({ kind: "emptyAnswer" })).toBe("(Provider-native search on p/m failed (The provider returned an empty web-search answer.); the next search route was tried.)");
		expect(note({ kind: "searchError" })).toContain("(The provider's search returned an unspecified tool error.)");
		expect(note({ kind: "searchError", status: "max_uses_exceeded" })).toContain("(The provider's search returned max_uses_exceeded.)");
		expect(note({ kind: "noResults" })).toContain("(The provider returned no search results.)");
		expect(note({ kind: "timedOut", seconds: 120 })).toContain("(Provider-native search did not answer within 120 seconds.)");
	});

	it("words each backend failure", () => {
		const line = (failure: Parameters<typeof webSearchResultText.attempt>[0]["failure"]) => webSearchResultText.attempt({ label: "B", failure });
		expect(line({ kind: "http", api: "Exa MCP", status: 502 })).toBe("B: Exa MCP HTTP 502");
		expect(line({ kind: "noData", api: "Exa MCP" })).toBe("B: Exa MCP returned an event stream with no data");
		expect(line({ kind: "toolError", api: "Exa MCP", text: "" })).toBe("B: Exa MCP tool error: (no detail)");
		expect(webSearchResultText.failed({ model: "p/m", failure: { kind: "cancelled" } })).toBe("web_search failed on p/m.\nSearch was cancelled.");
	});
});

describe("One Code's server-side web text", () => {
	it("says why a server-side call did not answer", () => {
		expect(nativeWebResultText.fallback({ kind: "authTimeout", seconds: 120 })).toBe("the call failed: Native web authentication did not answer within 120 seconds.");
		expect(nativeWebResultText.fallback({ kind: "stoppedEarly" })).toBe("the call stopped early (no stop reason)");
		expect(nativeWebResultText.fallback({ kind: "cutOffEarly" })).toBe("the call reached the output limit before it answered");
		expect(nativeWebResultText.fallback({ kind: "fetchError", code: "url_not_in_prior_context" })).toBe(
			"Anthropic's fetcher refused the URL (it only fetches public URLs from the conversation) (url_not_in_prior_context)",
		);
		expect(nativeWebResultText.fallback({ kind: "fetchError", code: "brand_new_code" })).toBe("Anthropic's fetcher returned brand_new_code (brand_new_code)");
	});

	it("puts the URL and the question in the nested fetch's user message", () => {
		expect(nativeWeb.fetch.user({ url: "https://a.example/x", prompt: "What version?" })).toBe("Page: https://a.example/x\n\nQuestion: What version?");
		expect(nativeWeb.fetch.system).toContain("untrusted data");
		expect(nativeWeb.searchSystem).toContain("untrusted data");
	});
});

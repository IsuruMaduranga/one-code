/** One Code's words for the nested web_fetch call on Anthropic's server tools. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("native web_fetch request", () => {
	it("puts the URL and the question in the user message and calls the page untrusted data", () => {
		const { fetch } = requireText("nativeWeb");
		expect(fetch.user({ url: "https://a.example/x", prompt: "What version?" })).toBe("Page: https://a.example/x\n\nQuestion: What version?");
		expect(fetch.system).toContain("untrusted data");
	});
});

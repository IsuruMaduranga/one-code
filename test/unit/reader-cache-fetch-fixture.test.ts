import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlToMarkdown } from "../../extensions/web-fetch/extract.ts";
import readerCacheFetchFixture, {
	READER_PROBE_LONG_URL,
	READER_PROBE_SHORT_URL,
} from "../e2e/reader-cache-fetch-fixture.ts";

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
	upstream = vi.fn(async () => new Response("provider response", { status: 201 }));
	vi.stubGlobal("fetch", upstream);
	readerCacheFetchFixture({} as never);
});

afterEach(() => {
	// The fixture replaces global fetch. Restore the real global before the next test.
	vi.unstubAllGlobals();
});

describe("reader cache fetch fixture", () => {
	it("intercepts only the exact long loopback URL and yields an extractable long document", async () => {
		const response = await fetch(READER_PROBE_LONG_URL);
		const html = await response.text();
		const extracted = await htmlToMarkdown(html, READER_PROBE_LONG_URL);

		expect(upstream).not.toHaveBeenCalled();
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("Editorial evidence guide");
		expect(html.length).toBeGreaterThan(20_000);
		expect(extracted.markdown).toContain("12\\. Guide section 12");
		expect(extracted.markdown).toContain("Before publication, record the owner, review date, source links");
	});

	it("intercepts the short loopback URL for both URL and Request inputs", async () => {
		const byUrl = await fetch(new URL(READER_PROBE_SHORT_URL));
		const byRequest = await fetch(new Request(READER_PROBE_SHORT_URL));
		const first = await htmlToMarkdown(await byUrl.text(), READER_PROBE_SHORT_URL);
		const second = await htmlToMarkdown(await byRequest.text(), READER_PROBE_SHORT_URL);

		expect(upstream).not.toHaveBeenCalled();
		expect(first.markdown).toContain("Section 12 requires a recorded owner before publication.");
		expect(second.markdown).toBe(first.markdown);
		expect(first.markdown.length).toBeLessThan(1_000);
	});

	it("forwards an arbitrary provider URL and its exact init to the original fetch", async () => {
		const input = "https://provider.example/v1/responses";
		const init = { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" };
		const response = await fetch(input, init);

		expect(upstream).toHaveBeenCalledTimes(1);
		expect(upstream).toHaveBeenCalledWith(input, init);
		expect(await response.text()).toBe("provider response");
	});

	it("forwards near-match loopback URLs and Request objects without rewriting them", async () => {
		const nearMatch = `${READER_PROBE_LONG_URL}?uncached=1`;
		const init = { headers: { "x-probe": "near-match" } };
		await fetch(nearMatch, init);
		const request = new Request("https://provider.example/v1/responses", { method: "POST", body: "request body" });
		await fetch(request);

		expect(upstream).toHaveBeenNthCalledWith(1, nearMatch, init);
		expect(upstream).toHaveBeenNthCalledWith(2, request, undefined);
	});
});

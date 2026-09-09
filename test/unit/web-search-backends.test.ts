import { describe, expect, it, vi } from "vitest";
import {
	BRAVE_KEY_ENV,
	EXA_MCP_URL,
	KEYLESS_NOTE,
	TAVILY_KEY_ENV,
	braveBackend,
	exaFreeBackend,
	filterByDomains,
	formatSearchResults,
	parseBrave,
	parseExaMcpText,
	parseMcpResponseBody,
	parseTavily,
	resolveChain,
	runChain,
	tavilyBackend,
	webSearchSettingsFrom,
	withSiteOperators,
	type FetchLike,
	type SearchBackend,
} from "../../extensions/web/backends.ts";

const jsonResponse = (body: unknown, init: { status?: number; contentType?: string } = {}): Response =>
	new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": init.contentType ?? "application/json" },
	});

describe("webSearchSettingsFrom", () => {
	it("keeps known backends in order and trims keys", () => {
		expect(webSearchSettingsFrom({ order: ["tavily", "nope", "brave"], apiKeys: { brave: " k1 ", tavily: "", other: "x" } })).toEqual({
			order: ["tavily", "brave"],
			apiKeys: { brave: "k1" },
		});
	});

	it("tolerates bad shapes", () => {
		expect(webSearchSettingsFrom(undefined)).toEqual({});
		expect(webSearchSettingsFrom("brave")).toEqual({});
		expect(webSearchSettingsFrom({ order: "brave", apiKeys: [] })).toEqual({});
	});
});

describe("resolveChain", () => {
	const fetchImpl: FetchLike = () => Promise.reject(new Error("unused"));

	it("is keyless Exa alone when nothing is configured", () => {
		expect(resolveChain({}, {}, fetchImpl).map((b) => b.name)).toEqual(["exa-free"]);
	});

	it("puts keyed backends before the free route, Brave first by default", () => {
		const env = { [BRAVE_KEY_ENV]: "b", [TAVILY_KEY_ENV]: "t" };
		expect(resolveChain(env, {}, fetchImpl).map((b) => b.name)).toEqual(["brave", "tavily", "exa-free"]);
	});

	it("takes keys from settings when the env has none, and env wins otherwise", () => {
		expect(resolveChain({}, { apiKeys: { tavily: "t" } }, fetchImpl).map((b) => b.name)).toEqual(["tavily", "exa-free"]);
		// A whitespace-only env value counts as unset.
		expect(resolveChain({ [BRAVE_KEY_ENV]: "  " }, { apiKeys: { brave: "b" } }, fetchImpl).map((b) => b.name)).toEqual(["brave", "exa-free"]);
	});

	it("honours a settings order over available backends and skips unkeyed ones named there", () => {
		const env = { [BRAVE_KEY_ENV]: "b", [TAVILY_KEY_ENV]: "t" };
		expect(resolveChain(env, { order: ["exa-free", "tavily"] }, fetchImpl).map((b) => b.name)).toEqual(["exa-free", "tavily", "brave"]);
		expect(resolveChain({}, { order: ["brave"] }, fetchImpl).map((b) => b.name)).toEqual(["exa-free"]);
	});
});

describe("domain filters", () => {
	const results = [
		{ title: "a", url: "https://docs.example.com/x", snippet: "" },
		{ title: "b", url: "https://www.example.com/y", snippet: "" },
		{ title: "c", url: "https://other.org/z", snippet: "" },
		{ title: "d", url: "not a url", snippet: "" },
	];

	it("keeps only allowed domains, including subdomains, and drops unparseable URLs", () => {
		expect(filterByDomains(results, { allowed: ["example.com"] }).map((r) => r.title)).toEqual(["a", "b"]);
		expect(filterByDomains(results, { allowed: ["https://www.example.com/"] }).map((r) => r.title)).toEqual(["a", "b"]);
	});

	it("drops blocked domains and passes everything through with no filters", () => {
		expect(filterByDomains(results, { blocked: ["docs.example.com"] }).map((r) => r.title)).toEqual(["b", "c"]);
		expect(filterByDomains(results, {})).toBe(results);
	});

	it("does not match a domain that merely ends with the same letters", () => {
		expect(filterByDomains([{ title: "e", url: "https://notexample.com/", snippet: "" }], { allowed: ["example.com"] })).toEqual([]);
	});

	it("renders site: operators", () => {
		expect(withSiteOperators("node lts", {})).toBe("node lts");
		expect(withSiteOperators("node lts", { allowed: ["nodejs.org"] })).toBe("node lts site:nodejs.org");
		expect(withSiteOperators("node lts", { allowed: ["a.com", "b.org"], blocked: ["c.net"] })).toBe("node lts (site:a.com OR site:b.org) -site:c.net");
	});
});

describe("parsers", () => {
	it("parseBrave reads web.results and drops entries without a url", () => {
		expect(parseBrave({ web: { results: [{ title: "T", url: "https://x", description: "D" }, { title: "no url" }] } })).toEqual([
			{ title: "T", url: "https://x", snippet: "D" },
		]);
		expect(parseBrave({})).toEqual([]);
	});

	it("parseTavily reads results[].content as the snippet", () => {
		expect(parseTavily({ results: [{ title: "T", url: "https://x", content: "C" }] })).toEqual([{ title: "T", url: "https://x", snippet: "C" }]);
	});

	it("parseExaMcpText splits blocks and joins highlights", () => {
		const text =
			"Title: Node.js — Download\nURL: https://nodejs.org/en/download\nPublished: N/A\nAuthor: N/A\nHighlights:\nGet Node.js® \n\nv24.20.0 LTS\n...\nv22.23.2 LTS\n\n---\n\nTitle: Second\nURL: https://example.com/2\nPublished: 2026-01-01\nHighlights:\nline one\nline two";
		expect(parseExaMcpText(text)).toEqual([
			{ title: "Node.js — Download", url: "https://nodejs.org/en/download", snippet: "Get Node.js® v24.20.0 LTS v22.23.2 LTS" },
			{ title: "Second", url: "https://example.com/2", snippet: "line one line two" },
		]);
	});

	it("parseMcpResponseBody handles plain JSON and SSE", () => {
		expect(parseMcpResponseBody('{"a":1}', "application/json")).toEqual({ a: 1 });
		expect(parseMcpResponseBody('event: message\ndata: {"a":2}\n\n', "text/event-stream")).toEqual({ a: 2 });
		expect(() => parseMcpResponseBody("event: message\n", "text/event-stream")).toThrow(/no data/);
	});
});

describe("backends over a fake fetch", () => {
	it("brave sends the key header, site operators and count, then post-filters", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () =>
			jsonResponse({ web: { results: [{ title: "in", url: "https://nodejs.org/a", description: "" }, { title: "out", url: "https://other.com/", description: "" }] } }),
		);
		const results = await braveBackend("KEY", fetchImpl).search("node", { allowed: ["nodejs.org"] }, 5, undefined);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(new URL(url).searchParams.get("q")).toBe("node site:nodejs.org");
		expect(new URL(url).searchParams.get("count")).toBe("5");
		expect((init?.headers as Record<string, string>)["x-subscription-token"]).toBe("KEY");
		expect(results.map((r) => r.title)).toEqual(["in"]);
	});

	it("brave names the env var on an auth failure", async () => {
		const fetchImpl: FetchLike = async () => jsonResponse("Unauthorized", { status: 401, contentType: "text/plain" });
		await expect(braveBackend("bad", fetchImpl).search("q", {}, 5, undefined)).rejects.toThrow(new RegExp(`401.*${BRAVE_KEY_ENV}.*Unauthorized`));
	});

	it("tavily posts a bearer token with include/exclude domains", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ results: [{ title: "T", url: "https://a.com/", content: "C" }] }));
		await tavilyBackend("TK", fetchImpl).search("q", { allowed: ["a.com"], blocked: ["b.com"] }, 3, undefined);
		const [, init] = fetchImpl.mock.calls[0];
		expect((init?.headers as Record<string, string>).authorization).toBe("Bearer TK");
		expect(JSON.parse(init?.body as string)).toEqual({ query: "q", max_results: 3, include_domains: ["a.com"], exclude_domains: ["b.com"] });
	});

	it("exa-free calls tools/call web_search_exa and reads an SSE reply", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () =>
			jsonResponse(
				'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Title: A\\nURL: https://a.com/\\nHighlights:\\nhi"}]}}\n\n',
				{ contentType: "text/event-stream" },
			),
		);
		const results = await exaFreeBackend(fetchImpl).search("q", {}, 4, undefined);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(EXA_MCP_URL);
		const body = JSON.parse(init?.body as string);
		expect(body.method).toBe("tools/call");
		expect(body.params).toEqual({ name: "web_search_exa", arguments: { query: "q", numResults: 4 } });
		expect(results).toEqual([{ title: "A", url: "https://a.com/", snippet: "hi" }]);
	});

	it("exa-free surfaces a rate limit and a JSON-RPC error loudly", async () => {
		await expect(exaFreeBackend(async () => jsonResponse("", { status: 429 })).search("q", {}, 4, undefined)).rejects.toThrow(/rate-limited/);
		await expect(
			exaFreeBackend(async () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } })).search("q", {}, 4, undefined),
		).rejects.toThrow(/Exa MCP error: boom/);
	});
});

describe("runChain + formatSearchResults", () => {
	const backend = (name: SearchBackend["name"], keyless: boolean, impl: SearchBackend["search"]): SearchBackend => ({
		name,
		label: name,
		keyless,
		search: impl,
	});
	const ok = [{ title: "T", url: "https://a.com/", snippet: "S" }];

	it("falls through a failing backend and records the failure", async () => {
		const chain = [backend("brave", false, async () => { throw new Error("down"); }), backend("exa-free", true, async () => ok)];
		const outcome = await runChain(chain, "q", {}, 10, undefined);
		expect(outcome.backend.name).toBe("exa-free");
		expect(outcome.failures).toEqual(["brave: down"]);
		const text = formatSearchResults("q", outcome);
		expect(text).toContain('Search results for "q" (via exa-free)');
		expect(text).toContain("Fell back after: brave: down");
		expect(text).toContain(KEYLESS_NOTE);
		expect(text).toContain("1. T\n   https://a.com/\n   S");
		expect(text).toContain("Sources:");
	});

	it("does not add the keyless note for a keyed backend and reports no results", async () => {
		const outcome = await runChain([backend("tavily", false, async () => [])], "q", {}, 10, undefined);
		const text = formatSearchResults("q", outcome);
		expect(text).not.toContain(KEYLESS_NOTE);
		expect(text).toContain("No results.");
	});

	it("names every backend when all fail", async () => {
		const chain = [backend("brave", false, async () => { throw new Error("a"); }), backend("exa-free", true, async () => { throw new Error("b"); })];
		await expect(runChain(chain, "q", {}, 10, undefined)).rejects.toThrow(/Every search backend failed:\n- brave: a\n- exa-free: b/);
	});

	it("stops on cancellation instead of trying the next backend", async () => {
		const controller = new AbortController();
		const second = vi.fn(async () => ok);
		const chain = [
			backend("brave", false, async () => { controller.abort(); throw new Error("aborted"); }),
			backend("exa-free", true, second),
		];
		await expect(runChain(chain, "q", {}, 10, controller.signal)).rejects.toThrow(/cancelled/);
		expect(second).not.toHaveBeenCalled();
	});
});

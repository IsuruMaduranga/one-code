/**
 * One Code's wording of the web_search fallback chain (its profile's
 * `webSearch` group): a backend's failure, the chain's results with the
 * keyless note, and the report when every backend failed. What the chain
 * does is tested in test/unit/web-search-backends.test.ts.
 */
import { describe, expect, it } from "vitest";
import { BRAVE_KEY_ENV, type ChainOutcome, runChain } from "../../extensions/web/backends.ts";
import { failureOf, fakeBackend, ONE_RESULT } from "../../test/unit/helpers/web-search.ts";
import { webSearch } from "../text/web-search/index.ts";


/** The chain's result in One Code's words. */
const formatSearchResults = (query: string, outcome: ChainOutcome) =>
	webSearch.chainResults({ query, label: outcome.backend.label, attempts: outcome.attempts, keyless: outcome.backend.keyless, results: outcome.results });
const KEYLESS_NOTE_START = "Note: these results came from Exa's free keyless endpoint";

describe("a backend's failure in One Code's words", () => {
	it("names the env var on an auth failure", () => {
		const failure = { kind: "http", api: "Brave Search API", status: 401, keyEnv: BRAVE_KEY_ENV, body: "Unauthorized" } as const;
		expect(webSearch.attempt({ label: "Brave Search", failure })).toBe(`Brave Search: Brave Search API HTTP 401 (check ${BRAVE_KEY_ENV}): Unauthorized`);
	});

	it("words a JSON-RPC error", () => {
		expect(webSearch.attempt({ label: "Exa", failure: { kind: "rpcError", api: "Exa MCP", message: "boom" } })).toBe("Exa: Exa MCP error: boom");
	});
});

describe("runChain + formatSearchResults", () => {
	it("falls through a failing backend and records the failure", async () => {
		const chain = [fakeBackend("brave", false, async () => { throw new Error("down"); }), fakeBackend("exa-free", true, async () => ONE_RESULT)];
		const text = formatSearchResults("q", await runChain(chain, "q", {}, 10, undefined));
		expect(text).toContain('Search results for "q" (via exa-free)');
		expect(text).toContain("Fell back after: brave: down");
		expect(text).toContain(KEYLESS_NOTE_START);
		expect(text).toContain("1. T\n   https://a.com/\n   S");
		expect(text).toContain("Sources:");
	});

	it("does not claim a key is missing after a configured backend failed", async () => {
		const outcome = await runChain([
			fakeBackend("brave", false, async () => { throw new Error("HTTP 503"); }),
			fakeBackend("exa-free", true, async () => ONE_RESULT),
		], "q", {}, 10, undefined);
		const text = formatSearchResults("q", outcome);
		expect(text).toContain("free keyless endpoint");
		expect(text).not.toContain("no search API key is configured");
	});

	it("does not add the keyless note for a keyed backend and reports no results", async () => {
		const outcome = await runChain([fakeBackend("tavily", false, async () => [])], "q", {}, 10, undefined);
		const text = formatSearchResults("q", outcome);
		expect(text).not.toContain(KEYLESS_NOTE_START);
		expect(text).toContain("No results.");
	});

	it("names every backend when all fail", async () => {
		const chain = [fakeBackend("brave", false, async () => { throw new Error("a"); }), fakeBackend("exa-free", true, async () => { throw new Error("b"); })];
		const failure = await failureOf(runChain(chain, "q", {}, 10, undefined));
		expect(webSearch.failed({ model: "p/m", failure: failure as never })).toBe("web_search failed on p/m.\nEvery search backend failed:\n- brave: a\n- exa-free: b");
	});
});

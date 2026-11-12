/**
 * Provider-native search results without pi-web-search's lossy truncateHead
 * wrapper: the answer, its sources and the other hits as data (the profile
 * words them), or a ProviderSearchError saying why there is no answer.
 */
import { applyCitations, type StreamResult } from "pi-web-search/src/api.ts";
import type { ProviderSearchFailure } from "./text.ts";

export class ProviderSearchError extends Error {
	constructor(readonly failure: ProviderSearchFailure) {
		super(`provider-native search failed: ${failure.kind}`);
	}
}

export function nativeSearchResult(result: StreamResult) {
	if (result.nativeSearchUsed === false) throw new ProviderSearchError({ kind: "noSearch" });
	// The vendor substitutes this placeholder when the stream contains no answer text.
	if (!result.text.trim() || result.text.trim() === "No answer available.") throw new ProviderSearchError({ kind: "emptyAnswer" });
	const cited = applyCitations(result.text, result.groundingMetadata);
	const sources = result.sources?.length ? result.sources : cited.sources;
	const failedSearch = result.searchResults?.find((item) => item.type === "web_search_tool_result_error");
	if (failedSearch) throw new ProviderSearchError({ kind: "searchError", status: failedSearch.status == null ? undefined : `${failedSearch.status}` });
	if (!sources.length && !result.searchResults?.some((item) => item.url)) throw new ProviderSearchError({ kind: "noResults" });
	const seen = new Set<string>();
	const extraResults = (result.searchResults ?? []).filter((item) => {
		if (!item.url || sources.some((source) => source.url === item.url)) return false;
		const key = `${item.title ?? ""}\t${item.url}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		answer: cited.text,
		sources,
		extra: extraResults.map((item) => ({ title: item.title, url: item.url! })),
		details: {
			sources,
			providerKind: result.providerKind,
			nativeSearchUsed: result.nativeSearchUsed,
			nativeSearchEvents: result.nativeSearchEvents,
			nativeSearchCalls: result.nativeSearchCalls,
			searchQueries: result.searchQueries ?? result.groundingMetadata?.webSearchQueries,
			searchResults: result.searchResults,
			citations: result.citations,
			grounded: sources.length > 0 || (result.searchResults?.length ?? 0) > 0,
			resultCount: result.searchResults?.length || sources.length,
		},
	};
}

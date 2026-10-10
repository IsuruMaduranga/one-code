/** Provider-native search formatting without pi-web-search's lossy truncateHead wrapper. */
import { applyCitations, type StreamResult } from "pi-web-search/src/api.ts";

export function formatNativeSearchResult(result: StreamResult) {
	if (result.nativeSearchUsed === false) throw new Error("The provider returned a response without performing a web search.");
	// The vendor substitutes this placeholder when the stream contains no answer text.
	if (!result.text.trim() || result.text.trim() === "No answer available.") throw new Error("The provider returned an empty web-search answer.");
	const cited = applyCitations(result.text, result.groundingMetadata);
	const sources = result.sources?.length ? result.sources : cited.sources;
	const failedSearch = result.searchResults?.find((item) => item.type === "web_search_tool_result_error");
	if (failedSearch) throw new Error(`The provider's search returned ${failedSearch.status ?? "an unspecified tool error"}.`);
	if (!sources.length && !result.searchResults?.some((item) => item.url)) throw new Error("The provider returned no search results.");
	const seen = new Set<string>();
	const extraResults = (result.searchResults ?? []).filter((item) => {
		if (!item.url || sources.some((source) => source.url === item.url)) return false;
		const key = `${item.title ?? ""}\t${item.url}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const parts = [cited.text];
	if (sources.length) parts.push(`## Sources\n${sources.map((source, i) => `${i + 1}. [${source.title}](${source.url})`).join("\n")}`);
	if (extraResults.length) {
		parts.push(`## Additional Search Results\n${extraResults.map((item, i) => `${i + 1}. ${item.title || item.url} - ${item.url}`).join("\n")}`);
	}
	return {
		text: parts.join("\n\n"),
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

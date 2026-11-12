import type { SearchResult } from "../../../extensions/tools/web/backends.ts";
import type { ProviderSearchFailure } from "../../../extensions/tools/web/text.ts";
import { webSearchResultText } from "../../../extensions/tools/web/text.ts";

/**
 * The result of a "test search" that `google/gemini-test`'s own search did
 * not answer, as the base builds it: Brave's `results`, then why the
 * provider's search failed.
 */
export function fellBack(failure: ProviderSearchFailure, results: readonly SearchResult[]): string {
	const chain = webSearchResultText.chainResults({ query: "test search", label: "Brave Search", attempts: [], keyless: false, results });
	return `${chain}\n\n${webSearchResultText.providerFailed({ backend: "google/gemini-test", failure })}`;
}

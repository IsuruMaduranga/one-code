import { requireText } from "../../../extensions/lib/profile/profile.ts";
import type { SearchResult } from "../../../extensions/tools/web/backends.ts";
import type { ProviderSearchFailure } from "../../../extensions/tools/web/text.ts";

/**
 * The result of a "test search" that `google/gemini-test`'s own search did
 * not answer, as the base builds it: Brave's `results`, then why the
 * provider's search failed.
 */
export function fellBack(failure: ProviderSearchFailure, results: readonly SearchResult[]): string {
	const words = requireText("webSearch");
	const chain = words.chainResults({ query: "test search", label: "Brave Search", attempts: [], keyless: false, results });
	return `${chain}\n\n${words.providerFailed({ backend: "google/gemini-test", failure })}`;
}

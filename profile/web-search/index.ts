/**
 * One Code's web_search text (the profile's `text.webSearch`): the
 * descriptions (description.ts), the parameters, each route's result, the
 * notes on routes that fell back, and every failure.
 */

import { BRAVE_KEY_ENV, SETTINGS_FILE, SETTINGS_SNIPPET, TAVILY_KEY_ENV } from "../../extensions/web/backends.ts";
import type { BackendAttempt, BackendFailure, ChainFailure, ProviderSearchFailure, WebSearchText } from "../../extensions/web/text.ts";
import { webSearchDescription } from "./description.ts";

/**
 * The note on every keyless result: the model should know these results are
 * best-effort and what the user can configure instead.
 */
const KEYLESS_NOTE =
	"Note: these results came from Exa's free keyless endpoint (rate-limited, best-effort). " +
	`For reliable search the user can add ${SETTINGS_SNIPPET} (or "tavily") to ${SETTINGS_FILE}, or set ${BRAVE_KEY_ENV} / ${TAVILY_KEY_ENV} in the environment. ` +
	"Brave and Tavily both have free tiers.";

function backendFailure(f: BackendFailure): string {
	switch (f.kind) {
		case "http":
			return `${f.api} HTTP ${f.status}${f.keyEnv ? ` (check ${f.keyEnv})` : ""}${f.body ? `: ${f.body}` : ""}`;
		case "rateLimited":
			return `${f.api} rate-limited the request (HTTP 429); retry shortly or configure a keyed backend`;
		case "noData":
			return `${f.api} returned an event stream with no data`;
		case "rpcError":
			return `${f.api} error: ${f.message}`;
		case "toolError":
			return `${f.api} tool error: ${f.text || "(no detail)"}`;
		case "other":
			return f.osMessage;
	}
}

const attempt = ({ label, failure }: BackendAttempt) => `${label}: ${backendFailure(failure)}`;

function chainFailure(f: ChainFailure): string {
	switch (f.kind) {
		case "cancelled":
			return "Search was cancelled.";
		case "allFailed":
			return `Every search backend failed:\n- ${f.attempts.map(attempt).join("\n- ")}`;
		case "other":
			return f.osMessage;
	}
}

function providerFailure(f: ProviderSearchFailure): string {
	switch (f.kind) {
		case "noSearch":
			return "The provider returned a response without performing a web search.";
		case "emptyAnswer":
			return "The provider returned an empty web-search answer.";
		case "searchError":
			return `The provider's search returned ${f.status ?? "an unspecified tool error"}.`;
		case "noResults":
			return "The provider returned no search results.";
		case "timedOut":
			return `Provider-native search did not answer within ${f.seconds} seconds.`;
		case "other":
			return f.osMessage;
	}
}

const SOURCES_REMINDER = 'After answering from these results, end with a "Sources:" list of the URLs you used as markdown links.';

export const webSearch: WebSearchText = {
	description: webSearchDescription,
	params: {
		query: "The search query to use",
		allowed_domains: "Only include search results from these domains",
		blocked_domains: "Never include search results from these domains",
	},
	searchKeywords: ["web", "search", "internet", "google", "news", "lookup", "online", "current"],
	cancelled: (query) => `Search for "${query}" was cancelled.`,
	nativeAnswer: ({ answer, cutOff, sourceLines, spec, filtered }) =>
		[
			answer,
			...(cutOff ? ["", "(The answer was cut off at the output limit and may be incomplete.)"] : []),
			"",
			"Sources:",
			...sourceLines,
			"",
			`(Searched with Anthropic's server-side web search with dynamic filtering, on ${spec}${filtered ? "; the domain filters were enforced by the search" : ""}.)`,
		].join("\n"),
	providerAnswer: ({ answer, sources, extra, backend, filtered }) =>
		[
			answer,
			...(sources.length ? [`## Sources\n${sources.map((source, i) => `${i + 1}. [${source.title}](${source.url})`).join("\n")}`] : []),
			...(extra.length ? [`## Additional Search Results\n${extra.map((item, i) => `${i + 1}. ${item.title || item.url} - ${item.url}`).join("\n")}`] : []),
			`(Searched with ${backend}.)`,
			...(filtered ? ["(Domain filters were applied as `site:` operators in the query — best-effort with provider-native search; verify the sources' hosts.)"] : []),
		].join("\n\n"),
	// Claude Code's WebSearch returns "result blocks with titles and URLs"; this
	// is that shape, with the backend named so the model can report its source
	// and, on the keyless route, the configuration note.
	chainResults: ({ query, label, attempts, keyless, results }) => {
		const lines = [`Search results for "${query}" (via ${label}):`];
		if (attempts.length) lines.push(`Fell back after: ${attempts.map(attempt).join("; ")}`);
		if (keyless) lines.push(KEYLESS_NOTE);
		lines.push("");
		if (!results.length) lines.push("No results.");
		else {
			results.forEach((result, index) => {
				lines.push(`${index + 1}. ${result.title || result.url}`, `   ${result.url}`);
				if (result.snippet) lines.push(`   ${result.snippet}`);
				lines.push("");
			});
			lines.push(SOURCES_REMINDER);
		}
		return lines.join("\n").trimEnd();
	},
	attempt,
	failed: ({ model, failure }) => `web_search failed on ${model}.\n${chainFailure(failure)}`,
	nativeFellBack: (reason) => `(Anthropic's server-side web search did not answer (${reason}); the results below come from the next search route.)`,
	providerFailed: ({ backend, failure }) => `(Provider-native search on ${backend} failed (${providerFailure(failure)}); the next search route was tried.)`,
};

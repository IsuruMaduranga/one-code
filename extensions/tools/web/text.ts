/**
 * What web_search needs from a profile (types only). The extension and its
 * backends decide what happened; the profile words it
 * (working-docs/features/profiles/). Backend labels and the user's progress
 * lines stay in the base as UI; the server-side search's prompt and fallback
 * reasons are the `nativeWeb` group (lib/request/native-web-text.ts).
 */

import type { DescriptionForm } from "../../lib/profile/tool-variants.ts";
import type { SearchResult } from "./backends.ts";
import { BRAVE_KEY_ENV, SETTINGS_FILE, SETTINGS_SNIPPET, TAVILY_KEY_ENV } from "./backend-names.ts";

/** Why one search backend failed. `api` names the service; `osMessage` is the system's own text. */
export type BackendFailure =
	/** `keyEnv` when the status says the key is wrong (401, 403); `body`: the response body, trimmed. */
	| { kind: "http"; api: string; status: number; keyEnv?: string; body?: string }
	| { kind: "rateLimited"; api: string }
	| { kind: "noData"; api: string }
	| { kind: "rpcError"; api: string; message: string }
	| { kind: "toolError"; api: string; text: string }
	| { kind: "other"; osMessage: string };

/** One backend tried before the one that answered, or before giving up. `label`: the backend's display name. */
export interface BackendAttempt {
	label: string;
	failure: BackendFailure;
}

/** Why no route answered. */
export type ChainFailure = { kind: "cancelled" } | { kind: "allFailed"; attempts: readonly BackendAttempt[] } | { kind: "other"; osMessage: string };

/** Why the provider's own search (pi-web-search) did not answer, so the chain ran. */
export type ProviderSearchFailure =
	| { kind: "noSearch" }
	| { kind: "emptyAnswer" }
	/** `status`: the provider's error status, when it gave one. */
	| { kind: "searchError"; status?: string }
	| { kind: "noResults" }
	| { kind: "timedOut"; seconds: number }
	| { kind: "other"; osMessage: string };

export interface WebSearchText {
	/** Short on frontier and workhorse, long on cheap and tiny (lib/profile/tool-variants.ts). */
	description(form: DescriptionForm): string;
	params: Record<"query" | "allowed_domains" | "blocked_domains", string>;
	/** Search terms for `tool_search`, beyond the tool's name and description. */
	searchKeywords: string[];
}

/** The group's results, refusals and notes, which the base words (`webSearchResultText`). */
export interface WebSearchResultText {
	cancelled(query: string): string;
	/**
	 * Anthropic's server-side search answered. `sourceLines`: one markdown link
	 * per source, already escaped (lib/request/anthropic-server-tools.ts sourceLine);
	 * `filtered`: the call had domain filters, which the search enforced.
	 */
	nativeAnswer(p: { answer: string; cutOff: boolean; sourceLines: readonly string[]; spec: string; filtered: boolean }): string;
	/** The provider's own search answered; `filtered`: the filters went in as `site:` operators. */
	providerAnswer(p: {
		answer: string;
		sources: readonly { title: string; url: string }[];
		extra: readonly { title?: string; url: string }[];
		backend: string;
		filtered: boolean;
	}): string;
	/** A third-party backend answered: `attempts` failed before it, `keyless` when it is the free endpoint. */
	chainResults(p: { query: string; label: string; attempts: readonly BackendAttempt[]; keyless: boolean; results: readonly SearchResult[] }): string;
	/** One failed backend, as the result and the tool's details name it. */
	attempt(attempt: BackendAttempt): string;
	/** `model`: the session model as `provider/id`. */
	failed(p: { model: string; failure: ChainFailure }): string;
	/** Appended when the server-side search fell back; `reason` as the `nativeWeb` group words it. */
	nativeFellBack(reason: string): string;
	/** Appended when the provider's own search failed and the chain ran. */
	providerFailed(p: { backend: string; failure: ProviderSearchFailure }): string;
}

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

/** The base's words of the group. */
export const webSearchResultText: WebSearchResultText = {
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

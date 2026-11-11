/**
 * The words of Anthropic's server-side web tools: the profile supplies the
 * nested calls' prompts (`NativeWebText`); why a call did not answer is
 * here (`nativeWebResultText`). web_search and
 * web_fetch both use it (lib/request/anthropic-server-tools.ts, lib/request/anthropic-server-call.ts).
 */

/** Why a server-side call did not answer, so the tool fell back. `osMessage` is the API's or the system's own text. */
export type NativeFallback =
	| { kind: "callFailed"; osMessage: string }
	| { kind: "authTimeout"; seconds: number }
	| { kind: "stoppedEarly"; stopReason?: string }
	| { kind: "noAnswer" }
	/** The answer hit the output limit before it was long enough to count. */
	| { kind: "cutOffEarly" }
	/** `code`: the fetch tool's error code (`url_not_accessible`, …). */
	| { kind: "fetchError"; code: string }
	| { kind: "noFetch" }
	/** `code`: the search tool's error code (`too_many_requests`, …). */
	| { kind: "searchError"; code: string }
	| { kind: "noResults" };

export interface NativeWebText {
	/** The nested fetch call's system prompt and its user message. */
	fetch: { system: string; user(p: { url: string; prompt: string }): string };
	/** The nested search call's system prompt (the user message is the query). */
	searchSystem: string;
}

/** The group's results, refusals and notes, which the base words (`nativeWebResultText`). */
export interface NativeWebResultText {
	/** Why the call did not answer, as a clause the tools' notes embed. */
	fallback(fallback: NativeFallback): string;
}

/**
 * What each fetch error means for the reader. Every code falls back to the
 * local fetch; the reason is what the result note tells the model.
 */
const FETCH_ERROR_REASONS: Readonly<Record<string, string>> = {
	url_not_accessible: "Anthropic's fetcher could not reach the page",
	url_not_allowed: "Anthropic's fetcher is not allowed to fetch this URL",
	unsupported_content_type: "Anthropic's fetcher cannot read this content type",
	url_not_in_prior_context: "Anthropic's fetcher refused the URL (it only fetches public URLs from the conversation)",
	max_uses_exceeded: "the fetch limit was reached",
	too_many_requests: "Anthropic's fetcher was rate-limited",
	url_too_long: "the URL is too long for Anthropic's fetcher",
	invalid_input: "Anthropic's fetcher rejected the URL",
};

function fallback(f: NativeFallback): string {
	switch (f.kind) {
		case "callFailed":
			return `the call failed: ${f.osMessage}`;
		case "authTimeout":
			return `the call failed: Native web authentication did not answer within ${f.seconds} seconds.`;
		case "stoppedEarly":
			return `the call stopped early (${f.stopReason ?? "no stop reason"})`;
		case "noAnswer":
			return "the model returned no answer";
		case "cutOffEarly":
			return "the call reached the output limit before it answered";
		case "fetchError":
			return `${FETCH_ERROR_REASONS[f.code] ?? `Anthropic's fetcher returned ${f.code}`} (${f.code})`;
		case "noFetch":
			return "the model answered without fetching the page";
		case "searchError":
			return `the search returned ${f.code}`;
		case "noResults":
			return "the search returned no results";
	}
}

/** The base's words of the group. */
export const nativeWebResultText: NativeWebResultText = {
	fallback,
};

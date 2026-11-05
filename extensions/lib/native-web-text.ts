/**
 * What Anthropic's server-side web tools need from a profile (types only):
 * the nested calls' prompts and why a call did not answer. web_search and
 * web_fetch both use it (lib/anthropic-server-tools.ts, lib/anthropic-server-call.ts).
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
	/** Why the call did not answer, as a clause the tools' notes embed. */
	fallback(fallback: NativeFallback): string;
}

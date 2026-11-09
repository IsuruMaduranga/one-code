/**
 * What web_search needs from a profile (types only). The extension and its
 * backends decide what happened; the profile words it
 * (working-docs/features/profiles/). Backend labels and the user's progress
 * lines stay in the base as UI; the server-side search's prompt and fallback
 * reasons are the `nativeWeb` group (lib/request/native-web-text.ts).
 */

import type { DescriptionForm } from "../../lib/profile/tool-variants.ts";
import type { SearchResult } from "./backends.ts";

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

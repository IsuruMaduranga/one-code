/**
 * Type stub for the one bundled community pi package. It ships raw TypeScript
 * written against a different pi version, so typechecking its sources against
 * our pinned pi types produces spurious errors. tsconfig `paths` maps every
 * `pi-web-search/src/*` subpath here, while jiti resolves the real module at
 * runtime.
 *
 * Only the exports `extensions/web/index.ts` uses are declared. Loosely typed
 * on purpose (`any` for pi-web-search's own result/context shapes): the goal is
 * to keep the package out of our typecheck, not to re-type it.
 */

declare module "pi-web-search/src/index.ts" {
	import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
	/** Registers `web_search` + Gemini-only `url_context` and the active-tools sync that hides url_context off Gemini. */
	const factory: (pi: ExtensionAPI) => unknown;
	export default factory;
}

declare module "pi-web-search/src/api.ts" {
	// The real api.ts (loaded by jiti at runtime) maps a Google provider — by
	// `provider` or `api` field — to "google", the only kind that supports
	// url_context. Declared loosely so the extension can call it with a model
	// object without importing pi-ai's Model type. Keeps the Gemini gate in one
	// place (pi-web-search's own) instead of a hand-copied string.
	export function getProviderKind(
		model: { provider?: string; api?: string } | undefined,
	): "google" | "openai" | "xai" | "anthropic" | "unsupported";
}

declare module "pi-web-search/src/web_search.ts" {
	import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
	/**
	 * pi-web-search's provider-native `web_search` execute (query + optional
	 * urls). It never sets `isError`; a failure is "Failed: …" text with
	 * `details.error` set — the caller stamps `isError` from that.
	 */
	export function webSearch(
		id: string,
		params: { query: string; urls?: string[] },
		signal: AbortSignal,
		onUpdate: AgentToolUpdateCallback | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<any> & { isError?: boolean }>;
}

declare module "pi-web-search/src/utils.ts" {
	import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
	/**
	 * The model native search would run on: the `web-search.json` opt-in model
	 * when configured, else the current model — or `undefined` when neither has
	 * a provider-native search API (every `openai-completions` model).
	 */
	export function getWebSearchModel(ctx: ExtensionContext): Promise<{ provider: string; id: string } | undefined>;
}

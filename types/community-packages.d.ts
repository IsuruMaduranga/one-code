/**
 * Type stub for the one bundled community pi package. It ships raw TypeScript
 * written against a different pi version, so typechecking its sources against
 * our pinned pi types produces spurious errors. tsconfig `paths` points the
 * compiler here, while jiti resolves the real module at runtime.
 */

declare module "pi-web-search/src/index.ts" {
	import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	): "google" | "openai" | "anthropic" | "unsupported";
}

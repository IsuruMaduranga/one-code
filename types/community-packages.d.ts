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

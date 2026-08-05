/**
 * Type stubs for bundled community pi packages. They ship raw TypeScript
 * written against varying pi versions; typechecking their sources with our
 * pinned pi types produces spurious errors. tsconfig `paths` points the
 * compiler here, while jiti resolves the real modules at runtime.
 */

declare module "pi-ask-user/index.ts" {
	import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
	const factory: (pi: ExtensionAPI) => unknown;
	export default factory;
}

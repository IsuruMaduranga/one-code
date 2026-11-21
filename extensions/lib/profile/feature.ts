/**
 * `feature(id, factory)`: the wrapper every extension entry file exports
 * (working-docs/features/profiles/). It applies the profile in force
 * (`lib/profile/profile.ts`) before the extension runs:
 *
 * - **Feature switch.** A feature the profile turns off never runs its
 *   factory, in the main session and in child sessions alike.
 * - **Tool registration.** The factory gets a view of `pi` that never
 *   registers a tool the profile turns off and drops such a tool from every
 *   `setActiveTools` list. Tools registered later (MCP servers, plugin LSP
 *   tools) pass through the same view. A tool the user's own profile words
 *   (lib/profile/user-profile.ts) is registered with that description.
 * - **Fail closed.** An invalid profile (a required feature off, an unknown
 *   feature, a pinned tool off) stops the process with the reason, so the
 *   harness never runs without its safety core.
 *
 * The rest of the tool switches live where each mechanism already has its
 * one home: tool-search keeps disabled tools out of the active set (pi's
 * built-ins included), adopts the tools the profile defers and ignores
 * deferral requests the profile overrides;
 * child sessions exclude disabled tools through pi's own `excludeTools`
 * (lib/agents/agent-catalog.ts `agentToolOptions`); the permission gate denies a call
 * to a disabled tool whatever path it arrived by (lib/rules/matcher.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FeatureId, PRODUCT_EXTENSIONS_DIR } from "./features.ts";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { activeProfile, failClosed, featureEnabled, isToolDisabled, PRODUCT_DIR, productExtensionEnabled, wordedTools } from "./profile.ts";
import { isRelativeInside } from "./paths.ts";
import { wordedByUser } from "./user-profile.ts";
import { brandedId } from "./brand.mjs";

/** `pi` as the profile lets an extension register tools: see the header. */
export function profiledPi(pi: ExtensionAPI): ExtensionAPI {
	const user = activeProfile().user;
	if (activeProfile().disabledTools.size === 0 && !user?.toolWording.size) return pi;
	return new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") {
				return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
					if (isToolDisabled(tool.name)) return;
					const description = wordedByUser(user, tool.name, tool.description);
					if (user?.toolWording.has(tool.name)) wordedTools().add(tool.name);
					target.registerTool(description === tool.description ? tool : { ...tool, description });
				};
			}
			if (key === "setActiveTools") {
				return (names: string[]) => target.setActiveTools(names.filter((name) => !isToolDisabled(name)));
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The profile in force, or the process stopped with the reason (see the header). */
function requireProfile(): void {
	try {
		activeProfile();
	} catch (error) {
		failClosed(error);
	}
}

export function feature<R>(id: FeatureId, factory: (pi: ExtensionAPI) => R): (pi: ExtensionAPI) => R | undefined {
	return (pi: ExtensionAPI) => {
		requireProfile();
		if (!featureEnabled(id)) return undefined;
		return factory(profiledPi(pi));
	};
}

/** The property a `productExtension` factory carries its name under, for the base suite's check that every product extension is wrapped. */
export const PRODUCT_EXTENSION_NAME = Symbol.for(brandedId("product-extension-name"));

/**
 * `productExtension(name, factory)`: the wrapper a product extension's entry
 * files export (`extensions/sdk/extension.ts`), `feature()` for the
 * product's own extensions. `name` is the extension's folder under the
 * product's `extensions/`. The factory runs only when the profile in force
 * runs that folder (`Profile.extensions`), in the main session and in child
 * sessions alike, and gets the same `profiledPi` view a base feature gets: a
 * tool the profile turns off is never registered. A name with no folder
 * stops the process, as an invalid profile does.
 */
export function productExtension<R>(name: string, factory: (pi: ExtensionAPI) => R): ((pi: ExtensionAPI) => R | undefined) & { readonly [PRODUCT_EXTENSION_NAME]: string } {
	// The entry file that calls the wrapper, read now while it is on the stack: a misspelled name is that file's fault, not the profile's.
	const entry = callerFile(productExtension);
	const wrapped = (pi: ExtensionAPI) => {
		requireProfile();
		const enabled = productExtensionEnabled(name);
		if (enabled === undefined) {
			const where = entry === undefined ? "A product extension's entry file" : `The product extension ${displayPath(entry)}`;
			failClosed(new Error(`productExtension("${name}"): the product has no folder ${PRODUCT_EXTENSIONS_DIR}/${name}/ with an index.ts; the name must be the extension's folder.`), where);
		}
		if (!enabled) return undefined;
		return factory(profiledPi(pi));
	};
	return Object.assign(wrapped, { [PRODUCT_EXTENSION_NAME]: name });
}

/** The file of the code that called `fn`, from V8's call sites; undefined where the stack does not say. */
function callerFile(fn: Function): string | undefined {
	const previous = Error.prepareStackTrace;
	try {
		Error.prepareStackTrace = (_, sites) => sites;
		const holder: { stack?: NodeJS.CallSite[] } = {};
		Error.captureStackTrace(holder, fn);
		const file = holder.stack?.[0]?.getFileName?.() ?? undefined;
		if (!file) return undefined;
		return file.startsWith("file:") ? fileURLToPath(file) : file;
	} catch {
		return undefined;
	} finally {
		Error.prepareStackTrace = previous;
	}
}

/** A path as the stop message shows it: from the product's folder when it is inside, else whole. */
function displayPath(path: string): string {
	const inside = relative(PRODUCT_DIR, path);
	return isRelativeInside(inside) ? inside.replaceAll("\\", "/") : path;
}

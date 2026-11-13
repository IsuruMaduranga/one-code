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
import type { FeatureId } from "./features.ts";
import { activeProfile, failClosed, featureEnabled, isToolDisabled } from "./profile.ts";
import { wordedByUser } from "./user-profile.ts";

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

export function feature<R>(id: FeatureId, factory: (pi: ExtensionAPI) => R): (pi: ExtensionAPI) => R | undefined {
	return (pi: ExtensionAPI) => {
		try {
			activeProfile();
		} catch (error) {
			failClosed(error);
		}
		if (!featureEnabled(id)) return undefined;
		return factory(profiledPi(pi));
	};
}

/**
 * `feature(id, factory)`: the wrapper every extension entry file exports
 * (working-docs/features/profiles/). It applies the profile in force
 * (`lib/profile.ts`) before the extension runs:
 *
 * - **Feature switch.** A feature the profile turns off never runs its
 *   factory, in the main session and in child sessions alike.
 * - **Tool switches.** The factory gets a view of `pi` that never registers a
 *   tool the profile turns off, drops such a tool from every `setActiveTools`
 *   list, and applies the profile's deferral choice: a deferral request for a
 *   tool the profile keeps up front (or turns off) is dropped, and a tool the
 *   profile defers is deferred right after it registers. Tools registered
 *   later (MCP servers, plugin LSP tools) pass through the same view.
 * - **Fail closed.** An invalid profile (a required feature off, an unknown
 *   feature, a pinned tool off) stops the process with the reason, so the
 *   harness never runs without its safety core.
 *
 * pi's built-in tools are activated by pi, not registered by an extension,
 * so the tool-search feature (always on) also removes disabled tools from the
 * active set when a session starts and before each turn. The permission gate
 * denies a call to a disabled tool whatever path it arrived by
 * (`permissions/matcher.ts`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FeatureId } from "./features.ts";
import { activeProfile, featureEnabled, isToolDisabled, toolSwitch } from "./profile.ts";

/** lib/deferred.ts DEFER_CHANNEL, spelled out: importing that module here would load the ledger into every extension. */
const DEFER_CHANNEL = "one-code:defer-tool";

function isDeferRequest(data: unknown): data is { name: string } {
	return typeof data === "object" && data !== null && typeof (data as { name?: unknown }).name === "string";
}

/** True when no tool switch is set, so the view would change nothing. */
function noToolSwitches(): boolean {
	return activeProfile().tools.size === 0;
}

/** `pi` as the profile lets an extension see it: see the header. */
export function profiledPi(pi: ExtensionAPI): ExtensionAPI {
	if (noToolSwitches()) return pi;
	const events = new Proxy(pi.events, {
		get(target, key) {
			if (key === "emit") {
				return (channel: string, data: unknown) => {
					if (channel === DEFER_CHANNEL && isDeferRequest(data)) {
						const sw = toolSwitch(data.name);
						if (sw?.enabled === false || sw?.deferred === false) return;
					}
					return target.emit(channel, data);
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Proxy(pi, {
		get(target, key) {
			if (key === "events") return events;
			if (key === "registerTool") {
				return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
					if (isToolDisabled(tool.name)) return;
					target.registerTool(tool);
					if (toolSwitch(tool.name)?.deferred === true) target.events.emit(DEFER_CHANNEL, { name: tool.name });
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

/** Remove disabled tools from the active set, when any is there (pi activates its built-ins itself). */
function dropDisabledTools(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const kept = active.filter((name) => !isToolDisabled(name));
	if (kept.length !== active.length) pi.setActiveTools(kept);
}

/** Stop the process: an invalid profile must never run degraded or without its gate. */
function failClosed(error: unknown): never {
	const reason = error instanceof Error ? error.message : String(error);
	process.stderr.write(`\nThe profile in profile/ is invalid, so the harness will not start: ${reason}\n\n`);
	process.exit(1);
}

export function feature<R>(id: FeatureId, factory: (pi: ExtensionAPI) => R): (pi: ExtensionAPI) => R | undefined {
	return (pi: ExtensionAPI) => {
		try {
			activeProfile();
		} catch (error) {
			failClosed(error);
		}
		if (!featureEnabled(id)) return undefined;
		if (id === "tool-search" && !noToolSwitches()) {
			pi.on("session_start", () => dropDisabledTools(pi));
			pi.on("before_agent_start", () => {
				dropDisabledTools(pi);
			});
		}
		return factory(profiledPi(pi));
	};
}

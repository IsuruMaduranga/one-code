/**
 * The profile in force: `profile/index.ts` at the repo root (One Code's, or a
 * product's in its place), resolved and checked once per module instance
 * (pure, apart from reading the environment and the profile module).
 *
 * Two environment variables can only turn things OFF, never on, so they can't
 * weaken the safety core: `ONECODE_FEATURES_OFF` (feature ids, never a guard
 * feature such as hooks) and `ONECODE_TOOLS_OFF` (tool names), each a
 * comma-separated list. They exist so
 * tests and the golden runs can check a product's switches without a second
 * profile folder.
 *
 * jiti gives every extension its own copy of this module; each copy resolves
 * the same constant profile and environment, so they agree.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profile as shippedProfile } from "../../profile/index.ts";
import { enabledFeatures, type FeatureId, featureProblems, isGuardFeature, TOOL_FEATURES } from "./features.ts";
import type { LiveTools } from "./live-tools.ts";
import type { Profile, ProfileText, ToolSwitch } from "./profile-contract.ts";

export const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../profile");

/**
 * Tools a profile may neither turn off nor defer: the harness's own plumbing.
 * `tool_search` reaches every deferred tool; a child reports through
 * `SendMessage` and `SubagentHandback`, and a workflow agent with a schema
 * through `structured_output` (subagents/agents.ts ALLOWLIST_ESSENTIALS).
 */
export const PINNED_TOOLS: ReadonlySet<string> = new Set(["tool_search", "SendMessage", "SubagentHandback", "structured_output"]);

export interface ResolvedProfile {
	features: ReadonlySet<FeatureId>;
	tools: ReadonlyMap<string, ToolSwitch>;
	/** The tools the profile turns off (`enabled: false`). */
	disabledTools: ReadonlySet<string>;
	/** Which tools the session can have: the switch is not off and the feature registering it (TOOL_FEATURES) is on. */
	live: LiveTools;
	/** Absolute entry files child sessions load after the base's own. */
	childExtensionPaths: readonly string[];
	/** The profile's model-facing text, built for `live`. */
	text: ProfileText;
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] {
	return (env[name] ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Resolve and check a profile, with the environment's off-switches merged in.
 * Throws, naming every problem at once, when it turns off a required feature,
 * names an unknown feature, or turns off or defers a pinned tool.
 */
export function resolveProfile(profile: Profile, env: NodeJS.ProcessEnv, profileDir: string): ResolvedProfile {
	const featureMap: Partial<Record<string, boolean>> = { ...profile.features };
	const envOff = envList(env, "ONECODE_FEATURES_OFF");
	for (const id of envOff) featureMap[id] = false;
	const tools = new Map<string, ToolSwitch>(Object.entries(profile.tools));
	for (const name of envList(env, "ONECODE_TOOLS_OFF")) tools.set(name, { ...tools.get(name), enabled: false });
	const problems = featureProblems(featureMap);
	for (const id of envOff.filter(isGuardFeature)) problems.push(`ONECODE_FEATURES_OFF cannot turn off "${id}": it guards tool calls (only a profile can)`);
	for (const name of PINNED_TOOLS) {
		const sw = tools.get(name);
		if (sw?.enabled === false) problems.push(`"${name}" cannot be turned off`);
		if (sw?.deferred === true) problems.push(`"${name}" cannot be deferred`);
	}
	if (problems.length > 0) throw new Error(`Invalid profile: ${problems.join("; ")}.`);
	const features = enabledFeatures(featureMap);
	const disabledTools = new Set([...tools].filter(([, sw]) => sw.enabled === false).map(([name]) => name));
	const live: LiveTools = {
		has: (name) => {
			const feature = TOOL_FEATURES[name];
			return !disabledTools.has(name) && (feature === undefined || features.has(feature));
		},
	};
	return {
		features,
		tools,
		disabledTools,
		live,
		childExtensionPaths: profile.childExtensions.map((entry) => resolve(profileDir, entry)),
		text: profile.text({ live }),
	};
}

let active: ResolvedProfile | undefined;

/** The shipped profile, resolved against this process's environment on first use. Throws when it is invalid. */
export function activeProfile(): ResolvedProfile {
	active ??= resolveProfile(shippedProfile, process.env, PROFILE_DIR);
	return active;
}

/** Test seam: use `resolved` as the active profile (`undefined` resolves the shipped one again). */
export function setActiveProfileForTest(resolved: ResolvedProfile | undefined): void {
	active = resolved;
}

export function featureEnabled(id: FeatureId): boolean {
	return activeProfile().features.has(id);
}

/** The profile's model-facing text. */
export function profileText(): ProfileText {
	return activeProfile().text;
}

/** Stop the process: an invalid profile must never run degraded or without its gate. */
export function failClosed(error: unknown): never {
	const reason = error instanceof Error ? error.message : String(error);
	process.stderr.write(`\nThe profile in profile/ is invalid, so the harness will not start: ${reason}\n\n`);
	process.exit(1);
}

/**
 * A feature's text group, for a feature that is on. A profile may leave out
 * the group of a feature it turns off; one it leaves on without its text is
 * invalid and stops the process.
 */
export function requireText<K extends keyof ProfileText>(group: K): NonNullable<ProfileText[K]> {
	const text = profileText()[group];
	if (text === undefined) failClosed(new Error(`it has no text for "${group}", and that feature is on`));
	return text as NonNullable<ProfileText[K]>;
}

export function toolSwitch(name: string): ToolSwitch | undefined {
	return activeProfile().tools.get(name);
}

/** The profile turned this tool off: never registered, never active, denied if called. */
export function isToolDisabled(name: string): boolean {
	return activeProfile().disabledTools.has(name);
}

/**
 * Whether a tool can be in this session: no switch turned it off and the
 * feature that registers it (TOOL_FEATURES) is on. Text that names another
 * tool asks this and leaves out what is off.
 */
export function toolLive(name: string): boolean {
	return activeProfile().live.has(name);
}

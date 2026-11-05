/**
 * The profile in force: `profile/index.ts` at the repo root (One Code's, or a
 * product's in its place), resolved and checked once per module instance
 * (pure, apart from reading the environment and the profile module).
 *
 * Two environment variables can only turn things OFF, never on, so they can't
 * weaken the safety core: `ONECODE_FEATURES_OFF` (feature ids) and
 * `ONECODE_TOOLS_OFF` (tool names), each a comma-separated list. They exist so
 * tests and the golden runs can check a product's switches without a second
 * profile folder.
 *
 * jiti gives every extension its own copy of this module; each copy resolves
 * the same constant profile and environment, so they agree.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profile as shippedProfile } from "../../profile/index.ts";
import { enabledFeatures, type FeatureId, featureProblems } from "./features.ts";
import type { Profile, ToolSwitch } from "./profile-contract.ts";

export const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../profile");

/** Tools a profile may neither turn off nor defer: every deferred tool is reached through it. */
const PINNED_TOOLS = new Set(["tool_search"]);

export interface ResolvedProfile {
	features: ReadonlySet<FeatureId>;
	tools: ReadonlyMap<string, ToolSwitch>;
	/** The tools the profile turns off (`enabled: false`). */
	disabledTools: ReadonlySet<string>;
	/** Absolute entry files child sessions load after the base's own. */
	childExtensionPaths: readonly string[];
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
	for (const id of envList(env, "ONECODE_FEATURES_OFF")) featureMap[id] = false;
	const tools = new Map<string, ToolSwitch>(Object.entries(profile.tools));
	for (const name of envList(env, "ONECODE_TOOLS_OFF")) tools.set(name, { ...tools.get(name), enabled: false });
	const problems = featureProblems(featureMap);
	for (const name of PINNED_TOOLS) {
		const sw = tools.get(name);
		if (sw?.enabled === false) problems.push(`"${name}" cannot be turned off`);
		if (sw?.deferred === true) problems.push(`"${name}" cannot be deferred`);
	}
	if (problems.length > 0) throw new Error(`Invalid profile: ${problems.join("; ")}.`);
	return {
		features: enabledFeatures(featureMap),
		tools,
		disabledTools: new Set([...tools].filter(([, sw]) => sw.enabled === false).map(([name]) => name)),
		childExtensionPaths: profile.childExtensions.map((entry) => resolve(profileDir, entry)),
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

export function toolSwitch(name: string): ToolSwitch | undefined {
	return activeProfile().tools.get(name);
}

/** The profile turned this tool off: never registered, never active, denied if called. */
export function isToolDisabled(name: string): boolean {
	return activeProfile().disabledTools.has(name);
}

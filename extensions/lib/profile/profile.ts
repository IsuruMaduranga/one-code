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
 * the same constant profile and environment, so they agree. The profile
 * module itself (all of its text) is evaluated once per process and shared
 * through a global slot (`shippedProfile`): it is constant, and evaluating it
 * in each of the extensions' copies cost about a third of a second at startup.
 */

import { brandedId, envName } from "./brand.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shareModuleForTest, sharedModule } from "./shared-module.ts";
import { enabledFeatures, type FeatureId, featureProblems, isGuardFeature, TOOL_FEATURES } from "./features.ts";
import type { LiveTools } from "./live-tools.ts";
import type { Profile, ProfileText, ToolSwitch } from "./profile-contract.ts";
import type { SourceProvider } from "./sources.ts";

export const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../profile");

/**
 * Tools a profile may neither turn off nor defer: the harness's own plumbing.
 * `tool_search` reaches every deferred tool; a child reports through
 * `SendMessage` and `SubagentHandback`, and a workflow agent with a schema
 * through `structured_output` (lib/agents/agent-catalog.ts ALLOWLIST_ESSENTIALS).
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
	/** The absolute path of the module exporting the profile's source provider (lib/profile/sources.ts), if it has one. */
	sourcesModule?: string;
	/** The user's global AGENTS.md files besides pi's own, `~/` unexpanded. */
	globalAgentsFiles: readonly string[];
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
	const envOff = envList(env, envName("FEATURES_OFF"));
	for (const id of envOff) featureMap[id] = false;
	const tools = new Map<string, ToolSwitch>(Object.entries(profile.tools));
	for (const name of envList(env, envName("TOOLS_OFF"))) tools.set(name, { ...tools.get(name), enabled: false });
	const problems = featureProblems(featureMap);
	for (const id of envOff.filter(isGuardFeature)) problems.push(`${envName("FEATURES_OFF")} cannot turn off "${id}": it guards tool calls (only a profile can)`);
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
		...(profile.sources ? { sourcesModule: resolve(profileDir, profile.sources) } : {}),
		globalAgentsFiles: profile.globalAgentsFiles ?? [],
	};
}

/** The slot the evaluated profile module is shared under (lib/profile/shared-module.ts). */
const SHIPPED_PROFILE = brandedId("shipped-profile");
const PROFILE_MODULE = resolve(PROFILE_DIR, "index.ts");

/**
 * The shipped profile (`profile/index.ts`), evaluated by the first copy of
 * this module that needs it and shared with the rest (see the header). It is
 * loaded on demand rather than imported, so a copy that finds it in the slot
 * never evaluates it. Sharing is safe because the module holds no state: its
 * text is constant, and its code (the source provider) loads on first use.
 */
function shippedProfile(): Profile {
	return sharedModule<typeof import("../../../profile/index.ts")>(SHIPPED_PROFILE, PROFILE_MODULE).profile;
}

/** Test seam: the profile the slot shares, from the test run's own import of it. */
export function shareShippedProfileForTest(profile: Profile): void {
	shareModuleForTest(SHIPPED_PROFILE, { profile });
}

let active: ResolvedProfile | undefined;

/** The shipped profile, resolved against this process's environment on first use. Throws when it is invalid. */
export function activeProfile(): ResolvedProfile {
	active ??= resolveProfile(shippedProfile(), process.env, PROFILE_DIR);
	return active;
}

/** The slot key a profile module is shared under (lib/profile/shared-module.ts), by its absolute path. */
export function profileModuleKey(absolutePath: string): string {
	return brandedId(`profile-module:${absolutePath}`);
}

/**
 * The profile's source provider, loaded the first time a session asks for it
 * and shared once per process (lib/profile/shared-module.ts): it reads files through
 * lib/ modules a profile import must not pull in early (under test,
 * test/setup.ts loads the profile before a test file's own mocks exist), and
 * it holds no state. Undefined when the profile names none.
 */
export function sourceProvider(): SourceProvider | undefined {
	const path = activeProfile().sourcesModule;
	return path ? sharedModule<{ sources: SourceProvider }>(profileModuleKey(path), path).sources : undefined;
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
 * A text group the session reads. A profile may leave out the group of a
 * feature it turns off (the contract marks those optional); a missing group
 * the session reads is invalid and stops the process.
 */
export function requireText<K extends keyof ProfileText>(group: K): NonNullable<ProfileText[K]> {
	const text = profileText()[group];
	if (text === undefined) failClosed(new Error(`it has no text for "${group}", which this session reads`));
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

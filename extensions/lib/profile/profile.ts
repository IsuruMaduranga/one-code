/**
 * The profile in force: `profile/index.ts` at the repo root (One Code's, or a
 * product's in its place), or the product profile the launch chose
 * (`profile/profiles/<id>/index.ts`, lib/profile/brand.mjs), resolved and
 * checked once per module instance (pure, apart from reading the environment
 * and the profile module).
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

import { brandedId, envName, productBrand, profileDirName, profileSelection, userProfilesDir } from "./brand.mjs";
import { describeUserProfile, loadUserProfile, type UserProfile } from "./user-profile.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isRelativeInside, tildify } from "./paths.ts";
import { PACKAGE_ROOT } from "../core/package-root.ts";
import { processState } from "./process-state.ts";
import { shareModuleForTest, sharedModule } from "./shared-module.ts";
import { enabledFeatures, type FeatureId, featureProblems, isGuardFeature, PRODUCT_EXTENSIONS_DIR, TOOL_FEATURES, toolSetProblems } from "./features.ts";
import type { LiveTools } from "./live-tools.ts";
import type { Profile, ProfileText, ToolSwitch } from "./profile-contract.ts";
import { type ProductProvider, providerProblems } from "./product-providers.ts";
import { secretFileProblems } from "./secrets.ts";
import { languageServerProblems, type ResolvedLanguageServer, resolveLanguageServers } from "./language-servers.ts";
import type { OptionSpec } from "../shell/read-only-options.ts";
import { readOnlyCommandProblems, readOnlyCommandSpecs } from "../shell/product-read-only.ts";
import type { SourceProvider } from "./sources.ts";

/** The product's folder: the default profile, and what every profile of the product shares (`extensions/`, `themes/`). */
export const PRODUCT_DIR = join(PACKAGE_ROOT, "profile");

/** The folder of the profile in force: `PRODUCT_DIR`, or the chosen product profile's folder under it. */
export const PROFILE_DIR = join(PACKAGE_ROOT, ...profileDirName.split("/"));

/**
 * A catalog folder of the profile in force (`agents`, `skills`): the chosen
 * product profile's own when it has one, else the product's, so profiles
 * share a catalog unless one brings its own.
 */
export function catalogDir(name: string): string {
	const own = join(PROFILE_DIR, name);
	return PROFILE_DIR === PRODUCT_DIR || existsSync(own) ? own : join(PRODUCT_DIR, name);
}

/**
 * Tools a profile may neither turn off nor defer: the harness's own plumbing.
 * `tool_search` reaches every deferred tool; a child reports through
 * `SendMessage` and `SubagentHandback`, and a workflow agent with a schema
 * through `structured_output` (lib/agents/agent-catalog.ts ALLOWLIST_ESSENTIALS).
 */
export const PINNED_TOOLS: ReadonlySet<string> = new Set(["tool_search", "SendMessage", "SubagentHandback", "structured_output"]);

/** pi's built-in tools. Only `bash` has a feature (lib/profile/features.ts TOOL_FEATURES), which overrides it. */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Every tool the base or pi registers under a fixed name. */
const BASE_TOOLS: ReadonlySet<string> = new Set([...Object.keys(TOOL_FEATURES), ...BUILTIN_TOOLS, ...PINNED_TOOLS]);

/** A tool name without its case and underscores: `WebFetch` and `web_fetch` compare equal. */
const looseName = (name: string) => name.toLowerCase().replaceAll("_", "");

/**
 * Switch keys that miss a base tool only by spelling (`Bash`, `WebFetch`):
 * a switch is looked up by the registered name, so such a key would leave
 * the tool on without a word. A name unlike every base tool is a product's
 * own or an MCP tool, and passes.
 */
function misspelledTools(names: Iterable<string>): string[] {
	const known = new Map([...BASE_TOOLS].map((name) => [looseName(name), name]));
	const problems: string[] = [];
	for (const name of names) {
		const match = known.get(looseName(name));
		if (match !== undefined && match !== name) problems.push(`no tool is named "${name}": the switch for "${match}" is spelled "${match}"`);
	}
	return problems;
}

/**
 * `autoAllow` on a base tool: refused. The allow sits before containment and
 * the classifier in the gate, so on `bash` or `write` it would remove the
 * gate; the base tools that are safe without a prompt are already in the
 * gate's own set (lib/rules/matcher.ts AUTO_ALLOWED_TOOLS). The switch is for
 * a product's own tools.
 */
function baseToolSwitchProblems(tools: ReadonlyMap<string, ToolSwitch>): string[] {
	const problems: string[] = [];
	for (const [name, sw] of tools) {
		if (!BASE_TOOLS.has(name)) continue;
		if (sw.autoAllow === true) problems.push(`"${name}" is a base tool and cannot be marked autoAllow: the base decides which of its tools run without a prompt`);
		// Plan mode's read-only set is the base's for its own tools too: `readOnly` on `bash` would let plan mode write.
		if (sw.readOnly === true) problems.push(`"${name}" is a base tool and cannot be marked readOnly: the base decides which of its tools plan mode allows`);
	}
	return problems;
}

/** The text groups the contract marks optional. */
type OptionalGroup = { [K in keyof ProfileText]-?: undefined extends ProfileText[K] ? K : never }[keyof ProfileText];

/**
 * The features that read each optional text group: its owner, and every
 * feature that words something through it (a workflow agent's
 * worktree and tool-list errors are the `subagents` group's; /doctor resolves
 * the subagent model). A profile may leave a group out only when all of them are
 * off; `resolveProfile` checks it at load, because a reader that finds its
 * group missing can only stop the process, in the middle of a session.
 * A group read only where it is present (`background.cron` by subagents,
 * `lsp` by /doctor) lists its owner alone.
 */
export const TEXT_GROUP_READERS: Readonly<Record<OptionalGroup, readonly FeatureId[]>> = {
	notebook: ["notebook"],
	askUser: ["ask-user"],
	tasks: ["tasks"],
	worktree: ["worktree"],
	webFetch: ["web-fetch"],
	webSearch: ["web"],
	nativeWeb: ["web", "web-fetch"],
	sessionTitle: ["session-title"],
	init: ["init"],
	btw: ["btw"],
	recap: ["recap"],
	effort: ["effort"],
	planMode: ["plan-mode"],
	skill: ["skill"],
	mcp: ["mcp"],
	lsp: ["lsp"],
	background: ["background"],
	artifacts: ["artifacts"],
	toolStyle: ["tool-style"],
	compaction: ["compaction"],
	workflow: ["workflow"],
	shell: ["bash", "powershell"],
	doctor: ["doctor"],
	handback: ["subagents", "workflow"],
	subagents: ["subagents", "workflow"],
	subagentModels: ["subagents", "workflow", "doctor"],
};

/** The text groups every profile supplies: the contract's required members. */
const REQUIRED_GROUPS: Readonly<Record<Exclude<keyof ProfileText, OptionalGroup>, true>> = {
	systemPrompt: true,
	permissions: true,
	classifier: true,
	autoModeSetup: true,
	notifications: true,
	context: true,
	toolSearch: true,
};

/** The fields a profile may set; a misspelled or retired one would otherwise be ignored in silence. */
const PROFILE_FIELDS: Readonly<Record<keyof Profile, true>> = {
	features: true,
	tools: true,
	childExtensions: true,
	text: true,
	providers: true,
	secretFiles: true,
	readOnlyCommands: true,
	languageServers: true,
	sources: true,
	globalAgentsFiles: true,
};

/** The groups `text` lacks: a required one, or an optional one a feature that is on reads; one sentence each. */
function missingTextProblems(text: ProfileText, features: ReadonlySet<FeatureId>): string[] {
	const problems: string[] = Object.keys(REQUIRED_GROUPS)
		.filter((group) => text[group as keyof ProfileText] === undefined)
		.map((group) => `it has no text for "${group}", which every profile supplies`);
	for (const [group, readers] of Object.entries(TEXT_GROUP_READERS) as Array<[OptionalGroup, readonly FeatureId[]]>) {
		if (text[group] !== undefined) continue;
		const on = readers.filter((id) => features.has(id));
		if (on.length > 0) problems.push(`it has no text for "${group}", which ${on.map((id) => `"${id}"`).join(", ")} ${on.length === 1 ? "reads" : "read"}`);
	}
	return problems;
}

export interface ResolvedProfile {
	features: ReadonlySet<FeatureId>;
	tools: ReadonlyMap<string, ToolSwitch>;
	/** The tools the profile turns off: `enabled: false`, or a pi built-in whose overriding feature is off. */
	disabledTools: ReadonlySet<string>;
	/** Which tools the session can have: the switch is not off and the feature registering it (TOOL_FEATURES) is on. */
	live: LiveTools;
	/** Absolute entry files child sessions load after the base's own. */
	childExtensionPaths: readonly string[];
	/** The profile's model-facing text, built for `live`. */
	text: ProfileText;
	/** The profile's text for another tool set: a child session's, which loads fewer tools (lib/agents/child-extensions.ts). */
	textFor(live: LiveTools): ProfileText;
	/** The absolute path of the module exporting the profile's source provider (lib/profile/sources.ts), if it has one. */
	sourcesModule?: string;
	/** The user's global AGENTS.md files besides pi's own, `~/` unexpanded. */
	globalAgentsFiles: readonly string[];
	/** The profile's provider entries, by pi provider name (lib/profile/product-providers.ts). */
	providers: ReadonlyMap<string, ProductProvider>;
	/** The profile's secret file names, lowercased (lib/profile/secrets.ts). */
	secretFiles: ReadonlySet<string>;
	/** The option table of each read-only subcommand the profile declares (lib/shell/product-read-only.ts). */
	readOnlyCommands: ReadonlyMap<string, ReadonlyMap<string, OptionSpec>>;
	/** The profile's language servers, `${PROFILE_DIR}` filled in (lib/profile/language-servers.ts). */
	languageServers: readonly ResolvedLanguageServer[];
	/** The user's own profile over this one, when the launch chose one (lib/profile/user-profile.ts). */
	user?: UserProfile;
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] {
	return (env[name] ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * A child extension entry must be a file under the profile's extensions
 * folder: a misspelled one would otherwise fail only when the first subagent
 * starts, and one outside the folder escapes the import-surface check.
 */
function childExtensionProblems(entries: readonly string[], profileDir: string): string[] {
	const root = resolve(profileDir, PRODUCT_EXTENSIONS_DIR);
	const problems: string[] = [];
	for (const entry of entries) {
		const path = resolve(profileDir, entry);
		const inside = relative(root, path);
		if (!isRelativeInside(inside)) {
			problems.push(`child extension "${entry}" must be a file under ${PRODUCT_EXTENSIONS_DIR}/ in the profile folder`);
		} else if (!existsSync(path)) {
			problems.push(`child extension "${entry}" does not exist (${path})`);
		}
	}
	return problems;
}

/**
 * Resolve and check a profile, with the environment's off-switches merged in.
 * Throws, naming every problem at once, when it turns off a required feature,
 * names an unknown feature, misspells a base tool, marks one autoAllow, turns
 * off or defers a pinned tool, names a child extension that is missing or
 * outside the profile's extensions folder, declares a provider entry the
 * base cannot read, turns off a tool its feature or another live tool
 * cannot do without, or leaves out a text group a feature that is on reads.
 * `extensionsRoot` is the folder child extension entries are relative to: the
 * product's, which every product profile shares (default: `profileDir`).
 * `user` is the user's own profile over it: its switches join the
 * environment's, under the same limits.
 */
export function resolveProfile(profile: Profile, env: NodeJS.ProcessEnv, profileDir: string, extensionsRoot: string = profileDir, user?: UserProfile): ResolvedProfile {
	const featureMap: Partial<Record<string, boolean>> = { ...profile.features };
	const envOff = envList(env, envName("FEATURES_OFF"));
	const envTools = envList(env, envName("TOOLS_OFF"));
	for (const id of [...envOff, ...(user?.featuresOff ?? [])]) featureMap[id] = false;
	const tools = new Map<string, ToolSwitch>(Object.entries(profile.tools));
	for (const name of [...envTools, ...(user?.toolsOff ?? [])]) tools.set(name, { ...tools.get(name), enabled: false });
	for (const name of user?.toolsDeferred ?? []) tools.set(name, { ...tools.get(name), deferred: true });
	for (const name of user?.toolsEager ?? []) tools.set(name, { ...tools.get(name), deferred: false });
	const problems = featureProblems(featureMap);
	if (user) {
		// The user's own lists: name the profile, since the fix is theirs to make.
		const where = `the profile "${user.name}" (${tildify(user.dir, homedir())})`;
		for (const id of user.featuresOff.filter(isGuardFeature)) problems.push(`${where} cannot turn off "${id}": it guards tool calls`);
		problems.push(...misspelledTools([...user.toolsOff, ...user.toolsDeferred, ...user.toolsEager, ...user.toolWording.keys()]).map((problem) => `${where}: ${problem}`));
	}
	for (const id of envOff.filter(isGuardFeature)) problems.push(`${envName("FEATURES_OFF")} cannot turn off "${id}": it guards tool calls (only a profile can)`);
	for (const field of Object.keys(profile)) if (!(field in PROFILE_FIELDS)) problems.push(`unknown profile field "${field}"`);
	problems.push(...misspelledTools(Object.keys(profile.tools)));
	// The user's own list: name the variable, since the fix is theirs to make.
	problems.push(...misspelledTools(envTools).map((problem) => `${envName("TOOLS_OFF")}: ${problem}`));
	problems.push(...baseToolSwitchProblems(tools));
	for (const name of PINNED_TOOLS) {
		const sw = tools.get(name);
		if (sw?.enabled === false) problems.push(`"${name}" cannot be turned off`);
		if (sw?.deferred === true) problems.push(`"${name}" cannot be deferred`);
	}
	problems.push(...childExtensionProblems(profile.childExtensions, extensionsRoot));
	problems.push(...providerProblems(profile.providers ?? {}));
	problems.push(...secretFileProblems(profile.secretFiles ?? []));
	problems.push(...readOnlyCommandProblems(profile.readOnlyCommands ?? {}));
	problems.push(...languageServerProblems(profile.languageServers ?? {}));
	if (problems.length > 0) throw new Error(`Invalid profile: ${problems.join("; ")}.`);
	const features = enabledFeatures(featureMap);
	const disabledTools = new Set([...tools].filter(([, sw]) => sw.enabled === false).map(([name]) => name));
	// A feature that overrides one of pi's built-ins (bash) takes the built-in
	// with it when it is off: skipping the override alone would leave pi's own
	// tool in the session, without the feature's guards.
	for (const name of BUILTIN_TOOLS) {
		const feature = TOOL_FEATURES[name];
		if (feature !== undefined && !features.has(feature)) disabledTools.add(name);
	}
	const toolProblems = toolSetProblems(features, disabledTools);
	if (toolProblems.length > 0) throw new Error(`Invalid profile: ${toolProblems.join("; ")}.`);
	const live: LiveTools = {
		has: (name) => {
			const feature = TOOL_FEATURES[name];
			return !disabledTools.has(name) && (feature === undefined || features.has(feature));
		},
	};
	const text = profile.text({ live });
	const textProblems = missingTextProblems(text, features);
	// An empty refusal would reach the model as an error with no reason.
	if (text.permissions?.secretFileRefusal?.trim() === "") textProblems.push(`its text "permissions.secretFileRefusal" must not be empty: leave it out for the base's own wording`);
	if (textProblems.length > 0) throw new Error(`Invalid profile: ${textProblems.join("; ")}.`);
	return {
		features,
		tools,
		disabledTools,
		live,
		childExtensionPaths: profile.childExtensions.map((entry) => resolve(extensionsRoot, entry)),
		text,
		textFor: (other) => profile.text({ live: other }),
		...(profile.sources ? { sourcesModule: resolve(profileDir, profile.sources) } : {}),
		globalAgentsFiles: profile.globalAgentsFiles ?? [],
		providers: new Map(Object.entries(profile.providers ?? {})),
		secretFiles: new Set((profile.secretFiles ?? []).map((name) => name.toLowerCase())),
		readOnlyCommands: readOnlyCommandSpecs(profile.readOnlyCommands ?? {}),
		languageServers: resolveLanguageServers(profile.languageServers ?? {}, profileDir),
		...(user ? { user } : {}),
	};
}

/** The user's own profile the launch chose, read from its folder; throws, naming every problem, when it cannot be used. */
function chosenUserProfile(): UserProfile | undefined {
	const name = profileSelection.userProfile;
	if (name === undefined) return undefined;
	// Read once per process: each extension has its own copy of this module, and all of them must see one content hash.
	const { profile, problems } = processState("profile:user", () => loadUserProfile(name, join(userProfilesDir(), name), productBrand.profiles ?? []));
	// The loader names each file by its full path; a message shows it from the home folder.
	if (!profile) throw new Error(`Invalid profile: ${problems.map((problem) => problem.replaceAll(userProfilesDir(), tildify(userProfilesDir(), homedir()))).join("; ")}.`);
	return profile;
}

/**
 * What a session records of the launch choices that shape its system prompt
 * and tools: the product profile's id, the user's profile with its content
 * hash, and the environment's off-switches. Undefined when the launch chose
 * none of them. A session resumed under other choices renders its system
 * prompt and tools again (lib/request/ledger/fold.ts, the "profile" epoch);
 * without that it would go on sending the recorded ones.
 */
export function profileKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const user = activeProfile().user;
	const off = [envName("FEATURES_OFF"), envName("TOOLS_OFF")].map((name) => envList(env, name).sort().join(","));
	const parts = [profileSelection.productProfile ?? "", user ? `${user.name}:${user.hash}` : "", off.some(Boolean) ? `off:${off.join("|")}` : ""];
	return parts.some(Boolean) ? parts.join(":").replace(/:+$/, "") : undefined;
}

/** The profile the launch chose, as /doctor names it: the product profile's id, the user's own with its folder (shown from `home`) and what it changes. Undefined on the default profile alone. */
export function profileSummary(home: string): string | undefined {
	const user = activeProfile().user;
	const parts = [...(profileSelection.productProfile !== undefined ? [profileSelection.productProfile] : []), ...(user ? [`${user.name} (${tildify(user.dir, home)}): ${describeUserProfile(user)}`] : [])];
	return parts.length > 0 ? parts.join(", with your own profile ") : undefined;
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
	active ??= resolveProfile(shippedProfile(), process.env, PROFILE_DIR, PRODUCT_DIR, chosenUserProfile());
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
	process.stderr.write(`\nThe profile in ${profileDirName}/, or a switch over it, is invalid, so the harness will not start: ${reason}\n\n`);
	process.exit(1);
}

/**
 * A text group the session reads. A profile may leave out a group only when
 * every feature that reads it is off (`TEXT_GROUP_READERS`, checked at load);
 * a reader missing from that table would find its group gone here, and that
 * stops the process.
 */
export function requireText<K extends keyof ProfileText>(group: K): NonNullable<ProfileText[K]> {
	const text = profileText()[group];
	if (text === undefined) failClosed(new Error(`it has no text for "${group}", which this session reads`));
	return text as NonNullable<ProfileText[K]>;
}

export function toolSwitch(name: string): ToolSwitch | undefined {
	return activeProfile().tools.get(name);
}

/** The read-only subcommands the profile declares for `command`, with their option tables. */
export function productReadOnlySubcommands(command: string): ReadonlyMap<string, OptionSpec> | undefined {
	return activeProfile().readOnlyCommands.get(command);
}

/** The profile's secret file names, lowercased; empty for a profile that lists none. */
export function secretFileNames(): ReadonlySet<string> {
	return activeProfile().secretFiles;
}

/**
 * The profile turned this tool off, by its switch or by turning off the
 * feature that overrides a pi built-in: never registered, never active,
 * denied if called.
 */
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

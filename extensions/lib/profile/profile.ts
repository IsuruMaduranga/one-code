/**
 * The profile in force: `profile/index.ts` at the repo root (One Code's, or a
 * product's in its place), or the product profile the launch chose or the
 * brand names as its default (`profile/profiles/<id>/index.ts`,
 * lib/profile/brand.mjs), resolved and
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
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isRelativeInside, tildify } from "./paths.ts";
import { PACKAGE_ROOT } from "../core/package-root.ts";
import { processState } from "./process-state.ts";
import { shareModuleForTest, sharedModule } from "./shared-module.ts";
import { enabledFeatures, type FeatureId, featureProblems, isGuardFeature, isProductExtensionFolder, PRODUCT_EXTENSIONS_DIR, TOOL_FEATURES, toolSetProblems } from "./features.ts";
import type { LiveTools } from "./live-tools.ts";
import type { Profile, ProfileText, ToolSwitch } from "./profile-contract.ts";
import { type ProductProvider, providerProblems } from "./product-providers.ts";
import { secretFileProblems } from "./secrets.ts";
import { type ProductSetting, productSettingProblems } from "./settings-keys.ts";
import { languageServerProblems, type ResolvedLanguageServer, resolveLanguageServers } from "./language-servers.ts";
import type { OptionSpec } from "../shell/read-only-options.ts";
import { readOnlyCommandProblems, readOnlyCommandSpecs } from "../shell/product-read-only.ts";
import type { SourceProvider } from "./sources.ts";
import { type OpenRouterRoutingDefault, openRouterRoutingProblems } from "./openrouter-routing.ts";
import { type ProductSandbox, productSandboxProblems } from "./product-sandbox.ts";
import { parseToolFlags, type PiToolFilter, piRegisters, piToolFilter, piToolFilterKey } from "./pi-tool-flags.ts";
import { launchSetsThinking, parseThinkingFlags } from "./pi-thinking-flags.ts";
import { type ThinkingDefaults, thinkingDefaultProblems } from "./thinking-defaults.ts";

/** The product's folder: what every profile of the product shares (`extensions/`, `themes/`), and the default profile unless the brand names one (`defaultProfile`). */
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
	shell: ["bash", "powershell", "sandbox", "background"],
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
	extensions: true,
	childExtensions: true,
	text: true,
	providers: true,
	secretFiles: true,
	readOnlyCommands: true,
	languageServers: true,
	settings: true,
	defaultThinkingLevels: true,
	openRouterRouting: true,
	sandbox: true,
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
	/** Which tools the session can have: the switch is not off, the feature registering it (TOOL_FEATURES) is on, and pi's launch flags keep it registered (`launchTools`). */
	live: LiveTools;
	/** The registry filter pi's `--tools`, `--exclude-tools` and `--no-tools` make for this process (lib/profile/pi-tool-flags.ts); absent when they filter nothing. */
	launchTools?: PiToolFilter;
	/**
	 * Every product extension folder (`<product>/extensions/<name>/index.ts`), by
	 * name, and whether this profile runs it (`Profile.extensions`); the
	 * `productExtension` wrapper reads it (lib/profile/feature.ts).
	 */
	productExtensions: ReadonlyMap<string, boolean>;
	/** The product profile in force, as the brand's `profiles` list spells it; undefined on a product whose default profile is `profile/` itself, when the launch chose none. */
	productProfile: string | undefined;
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
	/** The settings the profile declares for its own extensions (lib/profile/declared-settings.ts). */
	settings: ReadonlyMap<string, ProductSetting>;
	/** The thinking level each model tier starts at (lib/profile/thinking-defaults.ts); empty when the profile declares none. */
	defaultThinkingLevels: ThinkingDefaults;
	/** The OpenRouter routing defaults by model-id vendor (lib/request/openrouter-routing-defaults.ts). */
	openRouterRouting: ReadonlyMap<string, OpenRouterRoutingDefault>;
	/** The sandbox's starting settings and lock (lib/profile/product-sandbox.ts); absent when the profile declares none. */
	sandbox?: ProductSandbox;
	/** The user's switches that tried to turn a locked sandbox's feature off and were ignored, one line each; absent when none did. */
	sandboxOffIgnored?: readonly string[];
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
 * The product's extension folders the manifest's glob loads: every real
 * folder with an `index.ts`. A linked folder is none: pi expands the entry
 * with Node's `fs.globSync`, whose `*` does not follow a symbolic link, so a
 * profile listing one would run an extension the session never loads. Read
 * on each resolve, not once per process: /reload globs the entries again, and
 * a folder added since must not stop the wrapper (a few file checks per
 * extension copy at startup).
 */
export function productExtensionFolders(productDir: string): string[] {
	const root = resolve(productDir, PRODUCT_EXTENSIONS_DIR);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isProductExtensionFolder(entry.name) && existsSync(join(root, entry.name, "index.ts")))
		.map((entry) => entry.name)
		.sort();
}

/**
 * The product extensions a profile runs, folder by folder, and what is
 * wrong with its `extensions` list: a name with no folder would otherwise
 * leave the extension it meant off in silence.
 */
function productExtensionChoice(listed: unknown, folders: readonly string[]): { choice: Map<string, boolean>; problems: string[] } {
	if (listed !== undefined && (!Array.isArray(listed) || listed.some((name) => typeof name !== "string"))) {
		return { choice: new Map(folders.map((name) => [name, false])), problems: [`its "extensions" must be an array of folder names under ${PRODUCT_EXTENSIONS_DIR}/`] };
	}
	const names = listed as readonly string[] | undefined;
	const problems = (names ?? []).filter((name) => !folders.includes(name)).map((name) => `it lists the extension "${name}", which has no folder ${PRODUCT_EXTENSIONS_DIR}/${name}/ with an index.ts (a linked folder is none: pi's glob does not follow links)`);
	return { choice: new Map(folders.map((name) => [name, names === undefined || names.includes(name)])), problems };
}

/**
 * A child extension entry must be a file in one of the product's extension
 * folders (one with an `index.ts`), a folder the profile runs: a misspelled
 * one would otherwise fail only when the first subagent starts, one outside
 * the folder escapes the import-surface check, one outside an extension
 * folder has no name for its `productExtension` wrapper (which would stop the
 * process mid-session), and one the profile leaves out would never run.
 */
function childExtensionProblems(entries: readonly string[], productDir: string, choice: ReadonlyMap<string, boolean>): string[] {
	const root = resolve(productDir, PRODUCT_EXTENSIONS_DIR);
	const problems: string[] = [];
	for (const entry of entries) {
		const path = resolve(productDir, entry);
		const inside = relative(root, path);
		const folder = inside.split(/[\\/]/)[0];
		if (!isRelativeInside(inside)) {
			problems.push(`child extension "${entry}" must be a file under ${PRODUCT_EXTENSIONS_DIR}/ in the profile folder`);
		} else if (!existsSync(path)) {
			problems.push(`child extension "${entry}" does not exist (${path})`);
		} else if (!choice.has(folder)) {
			// A child-only folder was legal before each profile chose its extensions (decisions/bi-fork.md): name the move.
			const fix = folder !== inside && isProductExtensionFolder(folder) ? `give ${PRODUCT_EXTENSIONS_DIR}/${folder}/ an index.ts (one exporting productExtension("${folder}", () => {}) registers nothing in the main session) or move the file into a folder that has one` : `move it into a folder that has one`;
			problems.push(`child extension "${entry}" must sit in a product extension folder, one with an index.ts (${PRODUCT_EXTENSIONS_DIR}/<name>/), whose name its productExtension wrapper carries: ${fix}`);
		} else if (choice.get(folder) === false) {
			problems.push(`child extension "${entry}" is in the folder "${folder}", which the profile's extensions list leaves out`);
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
 * base cannot read, declares a setting the base reads itself (or one
 * without a type or description), declares a thinking level for something
 * that is not a tier (or a level pi lacks, or with the effort feature off),
 * declares an OpenRouter routing default OpenRouter would not take, turns
 * off a tool its feature or another live tool cannot do without, or leaves
 * out a text group a feature that is on reads.
 * `extensionsRoot` is the product's folder, which every product profile
 * shares: its `extensions/` holds the product extensions, and child extension
 * entries are relative to it (default: `PRODUCT_DIR`, whichever profile
 * `profileDir` is).
 * `user` is the user's own profile over it: its switches join the
 * environment's, under the same limits. `launchTools` is the filter pi's
 * tool flags make (`launchToolFilter`): it narrows `live` and the text built
 * for it, and is never checked, since pi applies it whatever the profile needs.
 * `productProfile` is the product profile's id it runs as (default: the
 * launch's, lib/profile/brand.mjs).
 */
export function resolveProfile(profile: Profile, env: NodeJS.ProcessEnv, profileDir: string, extensionsRoot: string = PRODUCT_DIR, user?: UserProfile, launchTools?: PiToolFilter, productProfile: string | undefined = profileSelection.productProfile): ResolvedProfile {
	const featureMap: Partial<Record<string, boolean>> = { ...profile.features };
	const envOff = envList(env, envName("FEATURES_OFF"));
	const envTools = envList(env, envName("TOOLS_OFF"));
	for (const id of [...envOff, ...(user?.featuresOff ?? [])]) featureMap[id] = false;
	// A locked sandbox (decisions/sandbox.md) stays on: the user's off-switches for it are ignored, and listed where the lock's other ignored settings are.
	const sandboxOffIgnored: string[] = [];
	if (profile.sandbox?.locked === true && profile.features.sandbox !== false && featureMap.sandbox === false) {
		featureMap.sandbox = true;
		if (envOff.includes("sandbox")) sandboxOffIgnored.push(`sandbox in ${envName("FEATURES_OFF")}`);
		if (user?.featuresOff.includes("sandbox")) sandboxOffIgnored.push(`sandbox in the featuresOff of the profile "${user.name}"`);
	}
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
	const extensions = productExtensionChoice(profile.extensions, productExtensionFolders(extensionsRoot));
	problems.push(...extensions.problems);
	problems.push(...childExtensionProblems(profile.childExtensions, extensionsRoot, extensions.choice));
	problems.push(...providerProblems(profile.providers ?? {}));
	problems.push(...secretFileProblems(profile.secretFiles ?? []));
	problems.push(...readOnlyCommandProblems(profile.readOnlyCommands ?? {}));
	problems.push(...languageServerProblems(profile.languageServers ?? {}));
	problems.push(...productSettingProblems(profile.settings ?? {}));
	problems.push(...thinkingDefaultProblems(profile.defaultThinkingLevels ?? {}));
	// The effort feature applies the levels: declared with it off, they would never take effect.
	if (profile.features.effort === false && Object.keys(profile.defaultThinkingLevels ?? {}).length > 0) problems.push(`it declares defaultThinkingLevels but turns off "effort", the feature that applies them`);
	problems.push(...openRouterRoutingProblems(profile.openRouterRouting ?? {}));
	problems.push(...productSandboxProblems(profile.sandbox));
	// The sandbox feature starts the sandbox: declared with it off, the block would never take effect.
	if (profile.features.sandbox === false && profile.sandbox !== undefined) problems.push(`it declares a sandbox block but turns off "sandbox", the feature that runs it`);
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
	// pi's own tools take a description only where an extension registers them again (tools/tool-style, and its child entry);
	// wording that could reach no tool is refused, not dropped.
	if (user && !features.has("tool-style")) {
		for (const name of user.toolWording.keys()) {
			if (BUILTIN_TOOLS.includes(name) && TOOL_FEATURES[name] === undefined) toolProblems.push(`the profile "${user.name}" words "${name}", whose description can change only while the "tool-style" feature is on: turn the feature on, or delete tools/${name}.md and tools/${name}.append.md`);
		}
	}
	if (toolProblems.length > 0) throw new Error(`Invalid profile: ${toolProblems.join("; ")}.`);
	const profileLive: LiveTools = {
		has: (name) => {
			const feature = TOOL_FEATURES[name];
			return !disabledTools.has(name) && (feature === undefined || features.has(feature));
		},
	};
	const live: LiveTools = launchTools ? { has: (name) => profileLive.has(name) && piRegisters(launchTools, name) } : profileLive;
	const text = profile.text({ live });
	const textProblems = missingTextProblems(text, features);
	// An empty refusal would reach the model as an error with no reason.
	if (text.permissions?.secretFileRefusal?.trim() === "") textProblems.push(`its text "permissions.secretFileRefusal" must not be empty: leave it out for the base's own wording`);
	// Left out is fine; a value that is not a function would throw on every render of the slider.
	if (text.effort?.sliderNote !== undefined && typeof text.effort.sliderNote !== "function") textProblems.push(`its text "effort.sliderNote" must be a function from the highlighted stop to a line (or undefined), not ${typeof text.effort.sliderNote}: leave it out for no note`);
	if (textProblems.length > 0) throw new Error(`Invalid profile: ${textProblems.join("; ")}.`);
	return {
		features,
		tools,
		disabledTools,
		live,
		...(launchTools ? { launchTools } : {}),
		productExtensions: extensions.choice,
		productProfile,
		childExtensionPaths: profile.childExtensions.map((entry) => resolve(extensionsRoot, entry)),
		text,
		textFor: (other) => profile.text({ live: other }),
		...(profile.sources ? { sourcesModule: resolve(profileDir, profile.sources) } : {}),
		globalAgentsFiles: profile.globalAgentsFiles ?? [],
		providers: new Map(Object.entries(profile.providers ?? {})),
		secretFiles: new Set((profile.secretFiles ?? []).map((name) => name.toLowerCase())),
		readOnlyCommands: readOnlyCommandSpecs(profile.readOnlyCommands ?? {}),
		languageServers: resolveLanguageServers(profile.languageServers ?? {}, profileDir),
		settings: new Map(Object.entries(profile.settings ?? {})),
		defaultThinkingLevels: { ...profile.defaultThinkingLevels },
		openRouterRouting: new Map(Object.entries(profile.openRouterRouting ?? {})),
		...(profile.sandbox ? { sandbox: profile.sandbox } : {}),
		...(sandboxOffIgnored.length > 0 ? { sandboxOffIgnored } : {}),
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
 * hash, the environment's off-switches, and pi's tool flags. Undefined when the launch chose
 * none of them and the default profile is `profile/` itself (a brand's
 * `defaultProfile` is a product profile, so its id is recorded). A session resumed under other choices renders its system
 * prompt and tools again (lib/request/ledger/fold.ts, the "profile" epoch);
 * without that it would go on sending the recorded ones.
 */
export function profileKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const user = activeProfile().user;
	const off = [envName("FEATURES_OFF"), envName("TOOLS_OFF")].map((name) => envList(env, name).sort().join(","));
	const parts = [activeProfile().productProfile ?? "", user ? `${user.name}:${user.hash}` : "", off.some(Boolean) ? `off:${off.join("|")}` : "", piToolFilterKey(activeProfile().launchTools) ?? ""];
	return parts.some(Boolean) ? parts.join(":").replace(/:+$/, "") : undefined;
}

/** The tools registered so far with the user's wording, for the process (lib/profile/feature.ts fills it). */
export function wordedTools(): Set<string> {
	return processState("profile:worded-tools", () => new Set<string>());
}

/** The profile the launch chose, as /doctor names it: the product profile's id, the user's own with its folder (shown from `home`) and what it changes. Undefined on the default profile alone, when it is `profile/` itself. */
export function profileSummary(home: string): string | undefined {
	const user = activeProfile().user;
	// A worded tool no extension has registered by now: a misspelled name, or a server that is not connected.
	const unused = user ? [...user.toolWording.keys()].filter((name) => !wordedTools().has(name)) : [];
	const note = unused.length > 0 ? `; no tool named ${unused.join(", ")} is registered, so that wording is unused` : "";
	const id = activeProfile().productProfile;
	const parts = [...(id !== undefined ? [id] : []), ...(user ? [`${user.name} (${tildify(user.dir, home)}): ${describeUserProfile(user)}${note}`] : [])];
	return parts.length > 0 ? parts.join(", with your own profile ") : undefined;
}

/** The slot the evaluated profile module is shared under (lib/profile/shared-module.ts). */
const SHIPPED_PROFILE = brandedId("shipped-profile");
/** The chosen profile's module (its folder's `index.ts`). */
export const PROFILE_MODULE = resolve(PROFILE_DIR, "index.ts");

/**
 * The shipped profile (the chosen folder's `index.ts`), evaluated by the first copy of
 * this module that needs it and shared with the rest (see the header). It is
 * loaded on demand rather than imported, so a copy that finds it in the slot
 * never evaluates it. Sharing is safe because the module holds no state: its
 * text is constant, and its code (the source provider) loads on first use.
 */
function shippedProfile(): Profile {
	// Typed by the contract, not by a path: a product whose brand names a default profile has no `profile/index.ts`.
	return sharedModule<{ profile: Profile }>(SHIPPED_PROFILE, PROFILE_MODULE).profile;
}

/** Test seam: the profile the slot shares, from the test run's own import of it. */
export function shareShippedProfileForTest(profile: Profile): void {
	shareModuleForTest(SHIPPED_PROFILE, { profile });
}

let active: ResolvedProfile | undefined;

/** The shipped profile, resolved against this process's environment and pi's tool flags on first use. Throws when it is invalid. */
export function activeProfile(): ResolvedProfile {
	active ??= resolveProfile(shippedProfile(), process.env, PROFILE_DIR, PRODUCT_DIR, chosenUserProfile(), launchToolFilter());
	return active;
}

/** The arguments pi was launched with, fixed for the process; a test runner's own are not pi's (test/setup.ts sets them empty). */
let launchArgs: readonly string[] = process.argv.slice(2);

/** Test seam: the arguments `launchToolFilter` and `launchThinkingFlag` read in place of the process's. */
export function setLaunchArgsForTest(args: readonly string[]): void {
	launchArgs = args;
}

/**
 * The registry filter pi's tool flags make for this process, read from the
 * arguments as `--profile` is (lib/profile/brand.mjs). pi gives an extension
 * no other way to see them while it loads, when the text is built
 * (`pi.getAllTools()` throws then). The bundled app takes the profile flags
 * out before pi parses them; they take no value that starts with "-", so
 * reading them here changes no tool flag. An SDK caller that passes `tools`
 * or `excludeTools` itself is not seen.
 */
export function launchToolFilter(args: readonly string[] = launchArgs): PiToolFilter | undefined {
	return piToolFilter(parseToolFlags(args));
}

/**
 * Whether pi's launch flags set the session's thinking level (`--thinking`,
 * `--model <pattern>:<level>`, a `--models` entry with a level), read from
 * the arguments as `launchToolFilter` reads the tool flags: pi gives an
 * extension no other way to see them. A level the launch set wins over the
 * profile's tier default (lib/models/tier-thinking.ts).
 */
export function launchThinkingFlag(args: readonly string[] = launchArgs): boolean {
	return launchSetsThinking(parseThinkingFlags(args));
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

/**
 * Stop the process: an invalid profile must never run degraded or without its
 * gate. `subject` names what is invalid when it is not the profile itself (a
 * product extension's entry file).
 */
export function failClosed(error: unknown, subject = `The profile in ${profileDirName}/, or a switch over it,`): never {
	const reason = error instanceof Error ? error.message : String(error);
	process.stderr.write(`\n${subject} is invalid, so the harness will not start: ${reason}\n\n`);
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
 * The product profile in force, as the brand's `profiles` list spells it:
 * the one the launch chose, the one a user's own profile sits on, or the
 * brand's `defaultProfile`. Undefined on the default profile of a product
 * whose default is `profile/` itself. Fixed for the process.
 */
export function productProfile(): string | undefined {
	return activeProfile().productProfile;
}

/**
 * Whether the profile runs the product extension in folder `name`; undefined
 * when the product has no such folder (lib/profile/feature.ts fails closed).
 */
export function productExtensionEnabled(name: string): boolean | undefined {
	return activeProfile().productExtensions.get(name);
}

/**
 * Whether a tool can be in this session: no switch turned it off and the
 * feature that registers it (TOOL_FEATURES) is on. Text that names another
 * tool asks this and leaves out what is off.
 */
export function toolLive(name: string): boolean {
	return activeProfile().live.has(name);
}

/**
 * Types for the plain-JS update-check module (extensions/lib/update-check.mjs),
 * shared by the bundled app and the doctor; tsc has no allowJs, so the
 * extension code and the unit tests see it through this declaration.
 */
declare module "*/lib/update-check.mjs" {
	export const APP_PACKAGE: string;
	export const EXTENSION_PACKAGE: string;
	export const HOMEBREW_FORMULA: string;
	export const NO_UPDATE_CHECK_VAR: string;
	export const UPGRADE_COMMANDS: { npm: string; brew: string; "pi-package": string };
	export function upgradeCommandFor(install: "app" | "pi-package", env?: Record<string, string | undefined>): string;
	export function registryPackumentUrl(name: string): string;
	export const CHECK_INTERVAL_MS: number;
	export const HOMEBREW_MIN_RELEASE_AGE_MS: number;
	export function minReleaseAgeFor(env?: Record<string, string | undefined>): number;
	export function isNewerVersion(candidate: string, current: string): boolean;
	export function pickAvailableVersion(
		packument: unknown,
		options?: { minReleaseAgeMs?: number; now?: number },
	): string | undefined;
	export function isOffline(env?: Record<string, string | undefined>): boolean;
	export function checkedRecently(stampPath: string | undefined, now?: number): boolean;
	export function createUpdateCheck(options: {
		currentVersion: string;
		upgradeHint: string;
		stampPath?: string;
		minReleaseAgeMs?: number;
	}): (pi: unknown) => void;
}

/** Types for the plain-JS launcher-environment module (extensions/lib/app-launch.mjs). */
declare module "*/app-launch.mjs" {
	export const APP_AGENT_DIR_VAR: string;
	export const LAUNCHER_ENV_VAR: string;
	export const INSTALL_METHOD_VAR: string;
	export const LAUNCHER_VARS: readonly string[];
	export function appAgentDir(env?: Record<string, string | undefined>, home?: string): string;
	export function installMethodFor(binRealPath: string | undefined): "brew" | "npm";
	export function applyLauncherEnv(
		env: Record<string, string | undefined>,
		options: { home?: string; appVersion: string; installMethod: "brew" | "npm" },
	): string;
	export function childProcessEnv(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
}

/** Types for the plain-JS replaced-built-ins module (extensions/lib/replaced-builtins.mjs). */
declare module "*/replaced-builtins.mjs" {
	export interface ReplacedBuiltin {
		name: string;
		ours: string;
	}
	export interface BuiltinLeftOn extends ReplacedBuiltin {
		/** Which setting keeps it on: the project's `+builtin:<name>`, else the user's (no `-` entry). */
		scope: "user" | "project";
	}
	export const REPLACED_BUILTINS: readonly ReplacedBuiltin[];
	export const BUILTIN_EXTENSIONS_PI: string;
	/** How a `!` override entry's glob is matched: pi's minimatch, or the module's port. */
	export type GlobMatcher = (pattern: string, path: string) => boolean;
	export const globMatches: GlobMatcher;
	export function builtinEnabled(name: string, userExtensions: unknown, projectExtensions: unknown, matches?: GlobMatcher): boolean;
	export function builtinsLeftOn(userExtensions: unknown, projectExtensions: unknown, matches?: GlobMatcher): BuiltinLeftOn[];
	export function withReplacedBuiltinsOff(userExtensions: unknown): { extensions: unknown[]; changed: boolean };
	export function replacedBuiltinsNotice(left: readonly BuiltinLeftOn[], configCommand?: string): string | undefined;
	export function replacedBuiltinsFix(left: readonly BuiltinLeftOn[], paths: { user: string; project: string }, configCommand?: string): string;
	export function withBuiltinsTurnedOff(userExtensions: unknown, names: readonly string[]): unknown[];
	export const TURN_OFF_YES: string;
	export const TURN_OFF_NO: string;
	export function turnOffPrompt(left: readonly BuiltinLeftOn[], settingsPath: string, configCommand?: string): string;
}

/** Types for the plain-JS compaction keep-window module (extensions/lib/compaction-keep.mjs). */
declare module "*/compaction-keep.mjs" {
	export interface CompactionKeepView {
		value: number;
		source: "project" | "user" | "default";
		/** The `provider/id` whose `compaction.modelOverrides` entry supplied the value. */
		model?: string;
	}
	export const ONE_CODE_KEEP_RECENT_TOKENS: number;
	export function withCompactionKeepBackfilled<S extends Record<string, unknown>>(settings: S): { settings: S; changed: boolean };
	export function compactionKeepView(userSettings: unknown, projectSettings: unknown, modelKey?: string): CompactionKeepView;
	export const KEEP_YES: string;
	export const KEEP_NO: string;
	export function keepWindowPrompt(settingsPath: string): string;
	export function keepWindowFix(settingsPath: string, model?: string): string;
}

/** Types for the plain-JS brand module (extensions/lib/brand.mjs); `profile/brand.json` must satisfy `Brand` (brand.test.ts). */
declare module "*/brand.mjs" {
	export interface Brand {
		/** Display name, in UI text: "One Code". */
		readonly name: string;
		/** Prefix of internal event and session-entry ids (`<idPrefix>:<name>`); fixed once, old sessions record it. */
		readonly idPrefix: string;
		/** The CLI command, settings labels and the app's own names: "onecode". */
		readonly bin: string;
		/** Prefix of the product's environment variables (`<envPrefix>_<suffix>`). */
		readonly envPrefix: string;
		/** The state directory's name under the home directory, and the project config folder's name: ".onecode". */
		readonly stateDir: string;
		/** The product's own instruction file: "ONECODE.md". */
		readonly productFile: string;
		/** The theme seeded on first run. */
		readonly theme: string;
		/** The product's repository web URL (`https://github.com/<owner>/<repo>`): user agents, doc links under `/blob/master/`, and package.json's repository, homepage and bugs fields. */
		readonly homepage: string;
		/** The banner's tagline. */
		readonly subtitle: string;
		/** The banner's wordmark rows. */
		readonly wordmark: readonly string[];
		readonly packages: {
			/** The bundled app's npm package. */
			readonly app: string;
			/** The extension package the app depends on. */
			readonly extension: string;
			/** The Homebrew formula, when the product ships one. */
			readonly homebrewFormula?: string;
		};
		/** Each package's npm listing, stamped into its package.json (scripts/apply-brand.mjs). */
		readonly packageInfo: {
			readonly app: PackageInfo;
			readonly extension: PackageInfo;
		};
	}
	export interface PackageInfo {
		readonly description: string;
		readonly keywords: readonly string[];
	}
	export function checkBrand(value: unknown): Brand;
	export const brand: Brand;
	export function brandedId(name: string): string;
	export function envName(suffix: string): string;
	export function productStateDir(env?: Record<string, string | undefined>, home?: string): string;
	export const stateDirPattern: string;
}

/** Types for the brand stamp (scripts/apply-brand.mjs). */
declare module "*/apply-brand.mjs" {
	/** The npm listing fields the stamp writes into both packages. */
	export interface Listing {
		name: string;
		description: string;
		keywords: string[];
		repository: { type: "git"; url: string; directory?: string };
		homepage: string;
		bugs: { url: string };
	}
	export function stampExtension<T extends Record<string, unknown>>(pkg: T): Omit<T, keyof Listing> & Listing;
	export function stampApp(pkg: Record<string, unknown>): Record<string, unknown> & Listing;
}

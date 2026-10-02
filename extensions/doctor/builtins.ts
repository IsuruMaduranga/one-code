/**
 * Which of pi's built-in extensions that One Code replaces the running pi
 * still loads, read from pi's own settings (lib/replaced-builtins.mjs has the
 * rule). Shared by the startup notice (branding) and `/doctor`, in the
 * session and from `onecode doctor`.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getPackageDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { piHasBuiltinExtensions } from "../lib/pi-version.ts";
import { type CompactionKeepView, compactionKeepView } from "../lib/compaction-keep.mjs";
import { BUILTIN_EXTENSIONS_PI, type BuiltinLeftOn, builtinsLeftOn, type GlobMatcher, globMatches } from "../lib/replaced-builtins.mjs";

/**
 * pi's own minimatch, the matcher its `!` override entries go through, loaded
 * from pi's install so every glob form (extglobs included) reads as pi reads
 * it. Falls back to the module's port when that copy cannot be loaded (a
 * compiled pi binary, an unusual layout).
 */
function piGlobMatcher(): GlobMatcher {
	try {
		const { minimatch } = createRequire(join(getPackageDir(), "package.json"))("minimatch") as { minimatch?: unknown };
		if (typeof minimatch === "function") return (pattern, path) => (minimatch as (path: string, pattern: string) => boolean)(path, pattern);
	} catch {
		// pi's copy is not reachable: use the port.
	}
	return globMatches;
}

export interface ReplacedBuiltinsView {
	/** The replaced built-ins pi still loads; empty when the settings turn them all off. */
	left: BuiltinLeftOn[];
	/** The settings files a fix edits. */
	paths: { user: string; project: string };
}

/**
 * The view for a pi with the built-ins, or undefined on an older pi (nothing
 * to report) or when the settings cannot be read (pi reports that itself).
 */
export function replacedBuiltinsView(
	piVersion: string | undefined,
	settings: () => Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">,
	paths: { agentDir: string; cwd: string },
): ReplacedBuiltinsView | undefined {
	if (!piHasBuiltinExtensions(piVersion, BUILTIN_EXTENSIONS_PI)) return undefined;
	try {
		const manager = settings();
		return {
			left: builtinsLeftOn(manager.getGlobalSettings().extensions, manager.getProjectSettings().extensions, piGlobMatcher()),
			paths: { user: join(paths.agentDir, "settings.json"), project: join(paths.cwd, CONFIG_DIR_NAME, "settings.json") },
		};
	} catch {
		return undefined;
	}
}

/** pi's compaction keep window and the settings files that set it, or undefined when they cannot be read. */
export function keepView(
	settings: () => Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">,
	paths: { agentDir: string; cwd: string },
): (CompactionKeepView & { paths: { user: string; project: string } }) | undefined {
	try {
		const manager = settings();
		return {
			...compactionKeepView(manager.getGlobalSettings(), manager.getProjectSettings()),
			paths: { user: join(paths.agentDir, "settings.json"), project: join(paths.cwd, CONFIG_DIR_NAME, "settings.json") },
		};
	} catch {
		return undefined;
	}
}

/** Whether this is the bundled app (its launcher sets `CC_VERSION`) or One Code on the user's own pi. */
export function installKind(env: NodeJS.ProcessEnv = process.env): "app" | "pi-package" {
	return env.CC_VERSION ? "app" : "pi-package";
}

/** How the user opens pi's config UI: `onecode config` under the bundled app. */
export function configCommand(install: "app" | "pi-package"): string {
	return install === "app" ? "onecode config" : "pi config";
}
